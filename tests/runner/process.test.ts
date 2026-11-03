import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ProcessExecutionError, runProcess } from '../../src/runner/process.js';

describe('runProcess', () => {
  it('reports the spawned PID once and disposes once before returning', async () => {
    const dispose = vi.fn();
    const onSpawn = vi.fn(() => dispose);
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      cwd: process.cwd(), timeoutMs: 5_000, onSpawn,
    });
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith(Number(result.stdout.toString()));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['spawn', 'dispose'] as const)('ignores diagnostic %s exceptions', async failure => {
    const fail = () => { throw new Error('diagnostic failure'); };
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      cwd: process.cwd(), timeoutMs: 5_000, onSpawn: failure === 'spawn' ? fail : () => fail,
    });
    expect(result.stdout.toString()).toBe('ok');
    expect(result.exitCode).toBe(0);
  });

  it('does not call the observer when spawning fails', async () => {
    const onSpawn = vi.fn();
    await expect(runProcess('/nonexistent/git-probe-command', [], { cwd: process.cwd(), timeoutMs: 5_000, onSpawn })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'cancel', 'output'] as const)('disposes the observer once on %s', async failure => {
    const dispose = vi.fn();
    const controller = new AbortController();
    await expect(runProcess(process.execPath, ['-e', 'process.stdout.write("large output"); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(), timeoutMs: failure === 'timeout' ? 100 : 5_000, maxStdoutBytes: failure === 'output' ? 1 : 1024,
      signal: controller.signal, onSpawn: () => {
        if (failure === 'cancel') controller.abort();
        return dispose;
      },
    })).rejects.toBeInstanceOf(ProcessExecutionError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes at exit even while a descendant holds stdout open', async () => {
    let resolveDisposed: () => void;
    const disposed = new Promise<void>(resolve => { resolveDisposed = resolve; });
    let closed = false;
    const running = runProcess(process.execPath, ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: ['ignore', 1, 'ignore'] }).unref();
    `], { cwd: process.cwd(), timeoutMs: 5_000, onSpawn: () => () => resolveDisposed() }).then(result => { closed = true; return result; });
    await disposed;
    expect(closed).toBe(false);
    expect((await running).exitCode).toBe(0);
  });

  it('captures stdout, stderr, exit status, and complete stdout lines', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write("first\\nsecond\\nremainder"); process.stderr.write("warning"); process.exitCode = 7;',
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        onStdoutLine: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString('utf8')).toBe('first\nsecond\nremainder');
    expect(result.stderr.toString('utf8')).toBe('warning');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(lines).toEqual(['first', 'second', 'remainder']);
  });

  it('passes metacharacters as a literal argument without invoking a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-process-'));
    const marker = join(directory, 'shell-was-invoked');
    const payload = `$(touch ${marker})`;

    try {
      const result = await runProcess(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1] ?? "")', payload],
        { cwd: directory, timeoutMs: 5_000 },
      );

      expect(result.stdout.toString('utf8')).toBe(payload);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminates and reports a process that exceeds its output budget', async () => {
    let error: unknown;
    try {
      await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxStdoutBytes: 32,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect(error).toMatchObject({ message: 'process output exceeded 32 bytes' });
    expect((error as ProcessExecutionError).result?.stdout.byteLength).toBeLessThanOrEqual(32);
  });
});
