import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease, type NativeCommit } from '../../src/core/session-native-store.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import { piCatalog } from '../../src/runner/pi/provider.js';
import { piChildEnvironment } from '../../src/runner/pi-host.js';

it.skipIf(process.env.CODEX_REQUIRE_PARITY !== 'true' || process.platform !== 'linux')('opens the packaged Pi child without host credentials and restores the committed sequence', async () => {
  expect(process.getuid?.()).toBe(10001);
  const store = new MemoryAgentsStore(); const runtimes = new SessionRuntimeStore(store);
  await runtimes.claim('owner', 'session', 'run', 1);
  const lease = nativeLease(store, 'owner', 'session', 'run', 0);
  const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog(['amazon.nova-micro-v1:0'], 'us-east-1'));
  const launch = { runtime: pin, sessionId: 'session', turnId: 'bootstrap', agent: sessionAgent({ model: 'amazon.nova-micro-v1:0' }, 'agent', 1), environment: { type: 'none' }, input: [] };
  let lastSeq = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = fork('/opt/agent-runtime/pi-child.mjs', [], { cwd: '/tmp', env: piChildEnvironment(), execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const waiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    let id = 0; let projections = 0;
    const invoke = (method: string, value?: unknown) => new Promise<unknown>((resolve, reject) => { const key = String(++id); waiters.set(key, { resolve, reject }); child.send({ kind: 'command', id: key, method, value }); });
    child.on('message', (raw: unknown) => {
      const message = raw as Record<string, unknown>;
      if (message.kind === 'result') { const waiter = waiters.get(String(message.id)); waiters.delete(String(message.id)); if (message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('Packaged child command failed')); return; }
      if (message.kind !== 'request') return;
      void (async () => {
        let value: unknown;
        if (message.method === 'load') value = await lease.load();
        else if (message.method === 'reserve') { const request = message.value as { count: number; requestId: string }; value = await lease.reserveIds(request.count, request.requestId); }
        else if (message.method === 'commit') value = await lease.commit(message.value as NativeCommit);
        else if (message.method === 'projection') { projections++; lastSeq = (message.value as { seq: number }).seq; }
        else throw new Error('Bootstrap must never request inference or tools');
        child.send({ kind: 'response', id: message.id, ok: true, value });
      })().catch(error => { for (const waiter of waiters.values()) waiter.reject(error); child.kill('SIGKILL'); });
    });
    const exited = once(child, 'exit');
    const timeout = setTimeout(() => { for (const waiter of waiters.values()) waiter.reject(new Error('Packaged child timeout')); child.kill('SIGKILL'); }, 10000);
    try {
      await invoke('initialize', { launch, allowedModelIds: ['amazon.nova-micro-v1:0'], tools: [], mode: 'persistent' });
      expect(projections).toBeGreaterThan(0); expect(lastSeq).toBe((await lease.load()).head?.seq);
      expect((await readFile(`/proc/${child.pid}/status`, 'utf8')).match(/^Uid:\s+(\d+)/m)?.[1]).toBe('10001');
      const environment = (await readFile(`/proc/${child.pid}/environ`, 'utf8')).split('\0');
      expect(environment.some(value => /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_CONTAINER_CREDENTIALS|AWS_BEARER_TOKEN|CODEX_API_KEY)/.test(value))).toBe(false);
      await invoke('close'); await exited;
    } finally { clearTimeout(timeout); if (child.connected) child.kill('SIGKILL'); }
  }
});
