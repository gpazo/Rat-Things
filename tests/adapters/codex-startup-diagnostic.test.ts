import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeCodexInitialization } from '../../src/adapters/codex-startup-diagnostic.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let logs: ReturnType<typeof vi.spyOn>;
function processFixture() {
  return Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), kill: vi.fn(() => true) });
}
const target = () => processFixture() as unknown as ChildProcess;
const observation = { v: 2, status: 'ok', arch: 'aarch64', identity: { before: 'ok', after: 'ok' }, task_access: 'ok', capped: false, threads: [] };
function start(child = target(), pending = () => true) {
  return observeCodexInitialization({ child, purpose: 'setup', ordinal: 2, spawnedAt: performance.now(), firstOutputAt: () => undefined, pending });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.mocked(existsSync).mockReturnValue(true);
  logs = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('samples only a still-pending live child and logs reconstructed fields', () => {
  const helper = processFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = start();
  vi.advanceTimersByTime(24_999);
  expect(spawn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(spawn).toHaveBeenCalledWith('/usr/bin/python3', ['-I', '-S', '/opt/agent-runtime/native-startup-probe.py', '123'], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
  });
  helper.stdout.emit('data', Buffer.from(JSON.stringify({ ...observation, secret: 'must-not-escape' })));
  helper.exitCode = 0;
  helper.emit('close', 0, null);
  expect(logs).toHaveBeenCalledTimes(1);
  expect(JSON.parse(logs.mock.calls[0]![0] as string)).toMatchObject({ message: 'Native harness startup sample', purpose: 'setup', ordinal: 2, status: 'sampled', observation });
  expect(logs.mock.calls.flat().join()).not.toContain('must-not-escape');
  cancel();
});

it.each(['cancelled', 'settled', 'exited', 'absent'] as const)('does not spawn for %s initialization', reason => {
  const child = target();
  if (reason === 'exited') Object.assign(child, { exitCode: 0 });
  if (reason === 'absent') vi.mocked(existsSync).mockReturnValue(false);
  const cancel = start(child, () => reason !== 'settled');
  if (reason === 'cancelled') cancel();
  vi.advanceTimersByTime(26_000);
  expect(spawn).not.toHaveBeenCalled();
  expect(logs).not.toHaveBeenCalled();
  cancel();
});

it('settles the host deadline without waiting for an uninterruptible helper to close', () => {
  const helper = processFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = start();
  vi.advanceTimersByTime(26_000);
  expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
  expect(logs).toHaveBeenCalledTimes(1);
  expect(JSON.parse(logs.mock.calls[0]![0] as string).status).toBe('timeout');
  helper.emit('close', 0, null);
  vi.advanceTimersByTime(10_000);
  expect(logs).toHaveBeenCalledTimes(1);
  cancel();
});

it('cancels an active helper when initialization settles without emitting a sample', () => {
  const helper = processFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = start();
  vi.advanceTimersByTime(25_000);
  cancel();
  expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
  helper.emit('close', 0, null);
  vi.advanceTimersByTime(1000);
  expect(logs).not.toHaveBeenCalled();
});

it.each(['overflow', 'invalid', 'error'] as const)('drops unsafe helper output on %s', kind => {
  const helper = processFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = start();
  vi.advanceTimersByTime(25_000);
  helper.stdout.emit('data', Buffer.from(kind === 'overflow' ? 'secret'.repeat(2000) : 'secret'));
  if (kind === 'error') helper.emit('error', new Error('secret'));
  else helper.emit('close', 0, null);
  expect(logs).toHaveBeenCalledTimes(1);
  expect(logs.mock.calls.flat().join()).not.toContain('secret');
  expect(JSON.parse(logs.mock.calls[0]![0] as string)).toMatchObject({ observation: null, status: kind === 'overflow' ? 'output_limit' : kind === 'invalid' ? 'invalid_output' : 'failed' });
  cancel();
});
