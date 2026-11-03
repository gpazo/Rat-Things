import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeGitFetch } from '../../src/runner/git-fetch-diagnostic.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!;
let logs: ReturnType<typeof vi.spyOn>;
function helperFixture() {
  return Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, stdout: new PassThrough(), kill: vi.fn(() => true) });
}
const observation = { v: 1, kind: 'git_fetch', status: 'ok', arch: 'aarch64', identity: { before: 'ok', after: 'ok' },
  proc_access: 'ok', tcp_access: 'ok', tcp6_access: 'ok', capped: false, processes: [] };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'getuid', { value: vi.fn(() => 0) });
  vi.mocked(existsSync).mockReturnValue(true);
  logs = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'getuid', getuid); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('takes one bounded snapshot after twenty seconds without passing Git credentials or arguments', () => {
  const helper = helperFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = observeGitFetch(42);
  vi.advanceTimersByTime(19_999);
  expect(spawn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(spawn).toHaveBeenCalledWith('/usr/bin/python3', ['-I', '-S', '/opt/agent-runtime/native-startup-probe.py', '--git-fetch', '42'], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
  });
  helper.stdout.emit('data', Buffer.from(JSON.stringify({ ...observation, secret: 'must-not-escape' })));
  helper.exitCode = 0;
  helper.emit('close', 0, null);
  vi.advanceTimersByTime(120_000);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(logs).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ message: 'Git fetch wait sample', status: 'sampled', observation }));
  expect(vi.getTimerCount()).toBe(0);
  cancel();
});

it.each(['cancelled', 'absent', 'unprivileged', 'nonlinux', 'invalid_pid'] as const)('does not spawn for %s targets', reason => {
  if (reason === 'absent') vi.mocked(existsSync).mockReturnValue(false);
  if (reason === 'unprivileged') vi.mocked(process.getuid!).mockReturnValue(1000);
  if (reason === 'nonlinux') Object.defineProperty(process, 'platform', { value: 'darwin' });
  const cancel = observeGitFetch(reason === 'invalid_pid' ? 0 : 42);
  if (reason === 'cancelled') cancel();
  vi.advanceTimersByTime(21_000);
  expect(spawn).not.toHaveBeenCalled();
  expect(logs).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  cancel();
});

it('ends the helper deadline without waiting for close or changing the Git process', () => {
  const helper = helperFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = observeGitFetch(42);
  vi.advanceTimersByTime(21_000);
  expect(helper.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(JSON.parse(logs.mock.calls[0]![0] as string)).toMatchObject({ status: 'timeout', observation: null });
  helper.emit('close', 0, null);
  expect(logs).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  cancel();
});

it('cancels an active helper and suppresses late output', () => {
  const helper = helperFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = observeGitFetch(42);
  vi.advanceTimersByTime(20_000);
  cancel();
  cancel();
  helper.stdout.emit('data', Buffer.from(JSON.stringify(observation)));
  helper.emit('close', 0, null);
  vi.advanceTimersByTime(1000);
  expect(helper.kill).toHaveBeenCalledTimes(1);
  expect(helper.stdout.destroyed).toBe(true);
  expect(logs).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['overflow', 'invalid', 'error', 'stdout_error', 'nonzero'] as const)('drops unsafe helper output on %s', kind => {
  const helper = helperFixture();
  vi.mocked(spawn).mockReturnValue(helper as never);
  const cancel = observeGitFetch(42);
  vi.advanceTimersByTime(20_000);
  helper.stdout.emit('data', Buffer.from(kind === 'overflow' ? 'secret'.repeat(2000) : 'secret'));
  if (kind === 'error') helper.emit('error', new Error('secret'));
  else if (kind === 'stdout_error') helper.stdout.emit('error', new Error('secret'));
  else helper.emit('close', kind === 'nonzero' ? 1 : 0, null);
  expect(logs).toHaveBeenCalledTimes(1);
  expect(logs.mock.calls.flat().join()).not.toContain('secret');
  expect(JSON.parse(logs.mock.calls[0]![0] as string)).toMatchObject({ observation: null, status: kind === 'overflow' ? 'output_limit' : kind === 'invalid' ? 'invalid_output' : 'failed' });
  expect(vi.getTimerCount()).toBe(0);
  cancel();
});

it('contains a synchronous helper spawn failure', () => {
  vi.mocked(spawn).mockImplementation(() => { throw new Error('secret'); });
  const cancel = observeGitFetch(42);
  expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
  expect(logs).not.toHaveBeenCalled();
  cancel();
});
