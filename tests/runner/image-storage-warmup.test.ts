import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { warmImageStorageUtilities } from '../../src/runner/image-storage-warmup.js';

const processState = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: processState.spawn }));

it('runs the fixed storage utility probes in order with only PATH and HOME', async () => {
  const calls: Array<{ executable: string; args: readonly string[]; environment: Readonly<Record<string, string>>; timeoutMs: number }> = [];

  await warmImageStorageUtilities('/private/home', async (command, environment, timeoutMs) => {
    calls.push({ executable: command.executable, args: command.args, environment, timeoutMs });
  });

  expect(calls.map(({ executable, args }) => [executable, args])).toEqual([
    ['/usr/bin/findmnt', ['--version']],
    ['/usr/bin/mount', ['--version']],
    ['/sbin/mount.s3files', ['--version']],
    ['/sbin/mount.nfs4', ['-V']],
    ['/usr/bin/openssl', ['version']],
    ['/sbin/efs-proxy', ['--help']],
  ]);
  expect(calls.every(({ environment }) => Object.keys(environment).sort().join(',') === 'HOME,PATH')).toBe(true);
  expect(calls.every(({ environment }) => environment.HOME === '/private/home')).toBe(true);
  expect(calls.every(({ environment }) => environment.PATH === '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')).toBe(true);
  expect(calls.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 30_000)).toBe(true);
});

it('stops the sequence when a utility command fails', async () => {
  const attempted: string[] = [];

  await expect(warmImageStorageUtilities('/private/home', async (command) => {
    attempted.push(command.executable);
    if (attempted.length === 2) throw new Error('command failed');
  })).rejects.toThrow('Storage utility warmup failed');

  expect(attempted).toEqual(['/usr/bin/findmnt', '/usr/bin/mount']);
});

it('limits the sequence to the shared 30 second deadline', async () => {
  let time = 1_000;
  const timeouts: number[] = [];

  await expect(warmImageStorageUtilities('/private/home', async (_command, _environment, timeoutMs) => {
    timeouts.push(timeoutMs);
    time += timeouts.length === 1 ? 25_500 : 4_500;
  }, () => time)).rejects.toThrow('Storage utility warmup exceeded its deadline');

  expect(timeouts).toEqual([30_000, 4_500]);
});

it('starts each probe without a shell and discards its output', async () => {
  const calls: unknown[][] = [];
  processState.spawn.mockImplementation((...args: unknown[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  });

  await warmImageStorageUtilities('/private/home');

  expect(calls).toHaveLength(6);
  expect(calls.every(([, , options]) => options && typeof options === 'object'
    && 'shell' in options && options.shell === false
    && 'stdio' in options && options.stdio === 'ignore'
    && 'env' in options && Object.keys(options.env as object).sort().join(',') === 'HOME,PATH'))
    .toBe(true);
});

it('kills a command that reaches the shared deadline', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  processState.spawn.mockReset().mockReturnValue(child);

  try {
    const warmup = warmImageStorageUtilities('/private/home', undefined, () => 0);
    const rejected = expect(warmup).rejects.toThrow('Storage utility warmup failed');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(processState.spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  } finally {
    vi.useRealTimers();
  }
});
