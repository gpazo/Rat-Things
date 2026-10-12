import { afterEach, expect, it, vi } from 'vitest';
import { createRunnerControlBridge } from '../../src/runner/control.js';
import { WorkspaceAdmission } from '../../src/runner/workspace-handoff.js';

const descriptors = new Map(['send', 'connected'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));
const harnessListeners = new Set(process.listeners('message'));
afterEach(() => { for (const [key, value] of descriptors) { if (value) Object.defineProperty(process, key, value); else Reflect.deleteProperty(process, key); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const command = (value: Record<string, unknown>) => {
  for (const listener of process.listeners('message')) if (!harnessListeners.has(listener)) listener({ channel: 'rat-things-agent-control', runId: 'run', ...value }, undefined);
};

it('drains admitted file operations and rejects new writes after checkpoint admission closes', async () => {
  const sent: Array<Record<string, unknown>> = [];
  Object.defineProperty(process, 'send', { configurable: true, value: (value: Record<string, unknown>) => { sent.push(value); } });
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  const admission = new WorkspaceAdmission();
  const bridge = createRunnerControlBridge('run', admission)!;
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const files = vi.fn(async () => { await active; return 'written'; });
  bridge.setEnvironmentFiles(files);
  let drained = false;
  await bridge.hooks.onTurnStarted!({ threadId: 'root', turnId: 'idle', steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
    checkpoint: async () => { await admission.seal(); drained = true; return 'checkpoint'; } });
  try {
    command({ commandId: 'first', type: 'environment_files', operation: { path: '/workspace/file' } });
    await tick();
    command({ commandId: 'checkpoint', type: 'checkpoint' });
    await tick();
    command({ commandId: 'late', type: 'environment_files', operation: { path: '/workspace/late' } });
    await tick();
    expect(drained).toBe(false);
    expect(files).toHaveBeenCalledOnce();
    expect(sent.find(value => value.commandId === 'late')).toMatchObject({ ok: false });
    release(); await tick();
    expect(drained).toBe(true);
    expect(sent.filter(value => value.type === 'command-result').map(value => value.commandId)).toEqual(['late', 'first', 'checkpoint']);
  } finally { release(); bridge.close(); }
});

it('waits for matching root-supervisor storage readiness and fails when the channel closes', async () => {
  const sent: Array<Record<string, unknown>> = [];
  Object.defineProperty(process, 'send', { configurable: true, value: (value: Record<string, unknown>) => { sent.push(value); } });
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  const bridge = createRunnerControlBridge('run')!;
  try {
    let ready = false;
    const first = bridge.prepareStorage().then(() => { ready = true; });
    expect(sent).toContainEqual({ channel: 'rat-things-agent-control', runId: 'run', type: 'prepare-storage' });
    command({ type: 'storage-ready', runId: 'stale-run', ok: true });
    await tick(); expect(ready).toBe(false);
    command({ type: 'storage-ready', ok: true });
    await first;
    const second = bridge.prepareStorage();
    const rejected = expect(second).rejects.toThrow('channel closed');
    bridge.close(); await rejected;
  } finally { bridge.close(); }
});
