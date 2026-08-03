import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ProcessExecutionError, runProcess } from '../../src/runner/process.js';

describe('runProcess', () => {
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
