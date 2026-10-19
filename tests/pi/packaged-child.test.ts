import { createServer, type ServerHttp2Stream } from 'node:http2';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventStreamMarshaller } from '@smithy/core/event-streams';
import { fromUtf8, toUint8Array, toUtf8 } from '@smithy/util-utf8';
import { expect, it } from 'vitest';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease, type NativeCommit } from '../../src/core/session-native-store.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import type { AgentSessionInputMessageParam, Turn } from '../../src/domain/agents-api.js';
import { piCatalog } from '../../src/runner/pi/provider.js';
import { piChildEnvironment } from '../../src/runner/pi-host.js';

const installedChild = '/opt/agent-runtime/pi-child.mjs';
const builtChild = fileURLToPath(new URL('../../dist/pi-child.mjs', import.meta.url));
const parityMode = process.env.CODEX_REQUIRE_PARITY === 'true';
const childPath = parityMode ? installedChild : builtChild;
const canExerciseBuiltBundle = existsSync(builtChild) && process.getuid?.() !== 0;
const preload = fileURLToPath(new URL('./fixtures/deny-network-bedrock-fixture.mjs', import.meta.url));
const modelId = 'amazon.nova-micro-v1:0';
const input: AgentSessionInputMessageParam[] = [{ role: 'user', content: [{ type: 'input_text', text: 'Return the packaged inference marker.' }] }];

function turn(id: string): Turn {
  return { id, object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
    status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null };
}

async function eventStream(): Promise<Buffer> {
  const marshaller = new EventStreamMarshaller({ utf8Encoder: toUtf8, utf8Decoder: fromUtf8 });
  const events = [
    { type: 'messageStart', payload: { role: 'assistant' } },
    { type: 'contentBlockStart', payload: { contentBlockIndex: 0, start: {} } },
    { type: 'contentBlockDelta', payload: { contentBlockIndex: 0, delta: { text: 'Packaged inference marker.' } } },
    { type: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
    { type: 'messageStop', payload: { stopReason: 'end_turn' } },
    { type: 'metadata', payload: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } },
  ];
  const bytes = marshaller.serialize((async function* () { yield* events; })(), event => ({
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: event.type },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: toUint8Array(JSON.stringify(event.payload)),
  }));
  const chunks: Buffer[] = [];
  for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function until(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Packaged child inference timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it.skipIf(!parityMode && !canExerciseBuiltBundle)('runs first inference in the packaged Pi child without network access or ambient credentials', async () => {
  if (parityMode) {
    expect(process.platform).toBe('linux');
    expect(process.getuid?.()).toBe(10001);
    expect(existsSync(installedChild)).toBe(true);
  }
  const fixtureBytes = await eventStream();
  const requests: Array<{ path: string; body: string }> = [];
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => {
      requests.push({ path: String(headers[':path'] ?? ''), body: Buffer.concat(chunks).toString('utf8') });
      stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'fixture-request' });
      stream.end(fixtureBytes);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Pi transport fixture failed to bind');

  const store = new MemoryAgentsStore();
  const runtimes = new SessionRuntimeStore(store);
  await runtimes.claim('owner', 'session', 'run', 1);
  const lease = nativeLease(store, 'owner', 'session', 'run', 0);
  const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog([modelId], 'us-east-1'));
  const launch = { runtime: pin, sessionId: 'session', turnId: 'turn_1', agent: sessionAgent({ model: modelId }, 'agent', 1), environment: { type: 'none' }, input };
  let tokenRequests = 0;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const currentTurnId = `turn_${attempt + 1}`;
      const child = fork(childPath, [], {
        cwd: '/tmp', env: { ...piChildEnvironment(), PI_TEST_BEDROCK_PORT: String(address.port) },
        execArgv: ['--import', preload], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
      const waiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
      let id = 0;
      let projected = initialSessionRuntime('session', 'agent', '');
      let projectedSeq = 0;
      let exited = false;
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => {
        exited = true;
        for (const waiter of waiters.values()) waiter.reject(new Error('Packaged child stopped'));
        waiters.clear(); resolve({ code, signal });
      }));
      child.on('message', (raw: unknown) => {
        const message = raw as Record<string, unknown>;
        if (message.kind === 'result') {
          const waiter = waiters.get(String(message.id)); waiters.delete(String(message.id));
          if (message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('Packaged child command failed'));
          return;
        }
        if (message.kind !== 'request') return;
        void (async () => {
          let value: unknown;
          if (message.method === 'load') value = await lease.load();
          else if (message.method === 'reserve') {
            const reservation = message.value as { count: number; requestId: string };
            value = await lease.reserveIds(reservation.count, reservation.requestId);
          } else if (message.method === 'commit') value = await lease.commit(message.value as NativeCommit);
          else if (message.method === 'projection') {
            const projection = message.value as { snapshot: typeof projected; seq: number };
            projected = projection.snapshot; projectedSeq = projection.seq;
            await runtimes.publishNative('owner', 'session', 'run', projection.seq, projection.snapshot);
          } else if (message.method === 'token') { tokenRequests++; value = 'fixture-only-token'; }
          else throw new Error('Packaged inference requested an unexpected host capability');
          child.send({ kind: 'response', id: message.id, ok: true, value });
        })().catch(() => child.send({ kind: 'response', id: message.id, ok: false }));
      });
      child.on('error', error => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); });
      const invoke = (method: string, value?: unknown) => new Promise<unknown>((resolve, reject) => {
        if (exited) return reject(new Error('Packaged child stopped'));
        const key = String(++id); waiters.set(key, { resolve, reject });
        child.send({ kind: 'command', id: key, method, value });
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        await invoke('initialize', { launch, allowedModelIds: [modelId], tools: [], mode: 'persistent' });
        await invoke('replay', { type: 'start', turn: turn(currentTurnId), input });
        await invoke('resume');
        await until(() => projected.turns.some(binding => binding.turn.id === currentTurnId && ['completed', 'failed', 'cancelled'].includes(binding.turn.status)));
        expect(tokenRequests).toBe(attempt + 1);
        expect(requests).toHaveLength(attempt + 1);
        const completed = projected.turns.find(binding => binding.turn.id === currentTurnId)!;
        expect(completed.turn.status).toBe('completed');
        expect(completed.items.flatMap(item => item.type === 'message' && item.role === 'assistant'
          ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('')).toContain('Packaged inference marker.');
        expect(requests.some(request => request.path.includes('/converse-stream') && request.body.includes('Return the packaged inference marker.'))).toBe(true);
        expect(projectedSeq).toBe((await lease.load()).head?.seq);
        expect((await runtimes.get('owner', 'session'))?.value.projectionSeq).toBe(projectedSeq);
        if (process.platform === 'linux') {
          const childUid = (await readFile(`/proc/${child.pid}/status`, 'utf8')).match(/^Uid:\s+(\d+)/m)?.[1];
          expect(Number(childUid)).toBe(process.getuid?.() ?? -1);
          if (process.env.CODEX_REQUIRE_PARITY === 'true') expect(childUid).toBe('10001');
          const environment = (await readFile(`/proc/${child.pid}/environ`, 'utf8')).split('\0');
          expect(environment.some(value => /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_CONTAINER_CREDENTIALS|AWS_BEARER_TOKEN|CODEX_API_KEY)/.test(value))).toBe(false);
        }
        await invoke('close');
        expect(await ended).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timeout);
        if (!exited) { child.kill('SIGKILL'); await ended; }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
