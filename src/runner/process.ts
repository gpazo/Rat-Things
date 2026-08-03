import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

export interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStdoutLine?: (line: string) => void;
  signal?: AbortSignal;
  uid?: number;
  gid?: number;
}

export class ProcessExecutionError extends Error {
  public constructor(
    message: string,
    public readonly result?: ProcessResult,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new ProcessExecutionError('process was cancelled');
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.gid !== undefined ? { gid: options.gid } : {}),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutRemainder = '';
  let outputError: Error | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid || child.exitCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };
  const terminate = () => {
    kill('SIGTERM');
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => kill('SIGKILL'), 5_000);
      forceKillTimer.unref();
    }
  };

  const consume = (
    stream: Readable,
    chunks: Buffer[],
    maximum: number,
    onChunk?: (chunk: Buffer) => void,
  ) => {
    stream.on('data', (chunk: Buffer) => {
      const current = chunks === stdout ? stdoutBytes : stderrBytes;
      if (current + chunk.length > maximum) {
        outputError = new Error(`process output exceeded ${maximum} bytes`);
        terminate();
        return;
      }
      chunks.push(chunk);
      if (chunks === stdout) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      onChunk?.(chunk);
    });
  };

  consume(
    child.stdout,
    stdout,
    options.maxStdoutBytes ?? 16 * 1024 * 1024,
    options.onStdoutLine
      ? (chunk) => {
          stdoutRemainder += chunk.toString('utf8');
          const lines = stdoutRemainder.split('\n');
          stdoutRemainder = lines.pop() ?? '';
          for (const line of lines) options.onStdoutLine?.(line);
        }
      : undefined,
  );
  consume(child.stderr, stderr, options.maxStderrBytes ?? 2 * 1024 * 1024);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  timer.unref();

  const abort = terminate;
  options.signal?.addEventListener('abort', abort, { once: true });
  let exitCode: number;
  try {
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    exitCode = code ?? (signal ? 128 : 1);
  } finally {
    clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (stdoutRemainder && options.onStdoutLine) options.onStdoutLine(stdoutRemainder);
  const result: ProcessResult = {
    exitCode,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    durationMs: Date.now() - started,
  };
  if (outputError) throw new ProcessExecutionError(outputError.message, result);
  if (timedOut) throw new ProcessExecutionError(`process timed out after ${options.timeoutMs}ms`, result);
  if (options.signal?.aborted) throw new ProcessExecutionError('process was cancelled', result);
  return result;
}
