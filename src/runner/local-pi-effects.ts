import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeLease } from '../core/session-native-store.js';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { isolatedCodexArguments } from '../domain/local-codex-arguments.js';
import type { LocalCodexHost } from './local-codex.js';
import type { PiEffects } from './pi/protocol.js';
import { PI_MANAGED_TOOLS, parsePiManagedOperation } from './pi-managed-tools.js';

export async function openLocalPiEffects(options: {
  sessionId: string; environmentId: string; generation: string; runId: string; epoch: number;
  connection: { url: string; harnessKey: string }; host: LocalCodexHost;
  lease: Pick<NativeLease, 'assertActive'>; stopWorker(): Promise<void>;
}): Promise<PiEffects> {
  const home = await mkdtemp(join(tmpdir(), 'rat-local-pi-effects-'));
  let closed: Promise<void> | undefined;
  let poisoned: Promise<void> | undefined;
  let threadId: string;
  let opening = true;
  const rpc = new CodexRpcClient({ binary: options.host.binary, cwd: home,
    binaryArguments: isolatedCodexArguments(['-c', 'cli_auth_credentials_store="file"', 'app-server']),
    environment: { PATH: options.host.environment.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: 'off',
      SSL_CERT_FILE: options.host.environment.SSL_CERT_FILE,
      CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: options.connection.url, CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: options.environmentId,
      CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: options.connection.harnessKey },
    onClose: () => { if (!opening && !closed && !poisoned) void poison().catch(() => {}); },
  });
  const poison = () => poisoned ??= (async () => {
    const results = await Promise.allSettled([bounded(options.stopWorker(), 10000), bounded(rpc.close(), 5000)]);
    await rm(home, { recursive: true, force: true });
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Pi worker cleanup could not be confirmed');
  })();
  const call = async (operation: string, fields: Record<string, unknown> = {}, timeout = 125000) => {
    const response = await rpc.call('mcpServer/tool/call', { threadId, server: 'rat_pi', tool: 'bridge',
      arguments: { version: 1, runId: options.runId, epoch: options.epoch, operation, ...fields } }, timeout);
    if (!record(response) || response.isError || !Array.isArray(response.content) || response.content.length !== 1) throw new Error('Invalid Pi bridge response');
    const content = response.content[0];
    if (!record(content) || content.type !== 'text' || typeof content.text !== 'string') throw new Error('Invalid Pi bridge response');
    return JSON.parse(content.text) as unknown;
  };
  try {
    await options.lease.assertActive();
    await rpc.initialize();
    const deadline = Date.now() + 5000;
    for (;;) {
      const state = await rpc.call('environment/status', { environmentId: 'remote' }, 5000);
      if (record(state) && state.status === 'ready') break;
      if (Date.now() >= deadline) throw new Error('Pi worker connection is unavailable');
      await delay(25);
    }
    const start = await rpc.call('thread/start', { cwd: '/workspace', environments: [{ environmentId: 'remote', cwd: '/workspace' }], ephemeral: true,
      approvalPolicy: 'never', sandbox: 'danger-full-access', selectedCapabilityRoots: [], config: { mcp_servers: { rat_pi: {
        command: 'node', args: ['/opt/rat-things/local-worker.mjs', '--pi-effects', options.runId, String(options.epoch)], cwd: '/workspace',
        environment_id: 'remote', required: true, enabled_tools: ['bridge'], default_tools_approval_mode: 'approve', tool_timeout_sec: 130,
      } } } });
    if (!record(start) || !record(start.thread) || typeof start.thread.id !== 'string') throw new Error('Pi bridge returned no thread');
    threadId = start.thread.id;
    const ready = await call('ready', {}, 5000);
    if (!record(ready) || ready.runId !== options.runId || ready.epoch !== options.epoch || ready.sessionId !== options.sessionId
      || ready.environmentId !== options.environmentId || ready.generation !== options.generation) throw new Error('Pi effect worker identity changed');
    opening = false;
  } catch (error) {
    try { await poison(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Pi bridge open and cleanup failed'); }
    throw error;
  }
  return {
    tools: PI_MANAGED_TOOLS,
    async execute(effect, signal) {
      parsePiManagedOperation(effect);
      signal.throwIfAborted();
      await options.lease.assertActive();
      signal.throwIfAborted();
      if (closed || poisoned) throw new Error('Pi effects are unavailable');
      const id = randomUUID();
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= (async () => {
          const result = await call('cancel', { id }, 7000);
          if (!record(result) || result.stopped !== true) throw new Error('Pi cancellation was not confirmed');
        })();
        void cancellation.catch(() => { void poison().catch(() => {}); });
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const result = await call('execute', { id, effect });
        await cancellation;
        if (!record(result) || !Array.isArray(result.output) || typeof result.isError !== 'boolean'
          || result.output.some(part => !record(part) || part.type !== 'text' || typeof part.text !== 'string')) throw new Error('Invalid Pi effect result');
        return { output: result.output as { type: 'text'; text: string }[], isError: result.isError };
      } catch (error) {
        try { await poison(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Pi effect failed with unconfirmed cleanup'); }
        throw error;
      } finally { signal.removeEventListener('abort', cancel); }
    },
    close: () => closed ??= (async () => {
      if (poisoned) { await poisoned; return; }
      try {
        const result = await call('close', {}, 8000);
        if (!record(result) || result.stopped !== true) throw new Error('Pi bridge close was not confirmed');
        await bounded(rpc.close(), 5000);
        await rm(home, { recursive: true, force: true });
      } catch (error) {
        try { await poison(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Pi bridge close and cleanup failed'); }
      }
    })(),
  };
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Pi worker cleanup timed out')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
