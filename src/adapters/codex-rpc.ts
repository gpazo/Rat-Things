import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export interface CodexRpcEvent { method: string; params: Record<string, unknown>; requestId?: string | number }

export class CodexRpcError extends Error {
  public readonly missingThread: boolean;
  public constructor(value: unknown) {
    super('Executor protocol request failed');
    this.missingThread = record(value) && value.code === -32600 && typeof value.message === 'string' && value.message.startsWith('no rollout found for thread id');
  }
}

/** A private protocol client. Public HTTP callers never choose raw RPC methods. */
export class CodexRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader;
  private nextId = 0;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  public constructor(options: { binary: string; binaryArguments?: string[]; cwd: string; environment: NodeJS.ProcessEnv; identity?: { uid: number; gid: number }; signal?: AbortSignal; onEvent?: (event: CodexRpcEvent) => void; onServerRequest?: (event: CodexRpcEvent & { requestId: string | number }) => Promise<unknown>; onClose?: () => void }) {
    this.child = spawn(options.binary, options.binaryArguments ?? ['app-server'], { cwd: options.cwd, env: options.environment, ...options.identity });
    // Report only fixed diagnostic categories, never native stderr (which may
    // include prompts, credentials, paths or provider payloads).
    const reported = new Set<string>();
    const errors = createInterface({ input: this.child.stderr });
    errors.on('line', line => {
      const category = /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(line) ? 'sqlite_contention'
        : /disk I\/O error|SQLITE_IOERR/i.test(line) ? 'sqlite_io'
        : /pool timed out while waiting for an open connection/i.test(line) ? 'sqlite_pool_timeout' : undefined;
      if (category && !reported.has(category)) {
        reported.add(category);
        console.error(JSON.stringify({ message: 'Native harness storage diagnostic', category }));
      }
    });
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', (line) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (!record(value)) return;
      if (typeof value.method === 'string') {
        const event: CodexRpcEvent = { method: value.method, params: record(value.params) ? value.params : {}, ...(typeof value.id === 'string' || typeof value.id === 'number' ? { requestId: value.id } : {}) };
        try { options.onEvent?.(event); } catch { void this.close(); return; }
        if (event.requestId !== undefined) {
          const initiated = { ...event, requestId: event.requestId };
          const task = Promise.resolve().then(() => options.onServerRequest ? options.onServerRequest(initiated) : Promise.reject(new Error('Host interaction is disabled')));
          void task.then(
            (result) => { if (!this.closed) this.child.stdin.write(`${JSON.stringify({ id: event.requestId, result })}\n`); },
            () => { if (!this.closed) this.child.stdin.write(`${JSON.stringify({ id: event.requestId, error: { code: -32601, message: 'Host interaction is unavailable' } })}\n`); },
          );
        }
        return;
      }
      const pending = typeof value.id === 'number' ? this.waiting.get(value.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer); this.waiting.delete(value.id as number);
      if (value.error) pending.reject(new CodexRpcError(value.error));
      else pending.resolve(value.result);
    });
    let notified = false;
    const fail = () => {
      this.closed = true;
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Executor protocol connection closed')); }
      this.waiting.clear();
      if (!notified) { notified = true; options.onClose?.(); }
    };
    this.child.once('error', () => { console.error(JSON.stringify({ message: 'Native harness process failed to start' })); fail(); });
    this.child.once('exit', (code, signal) => {
      if (!this.closed) console.error(JSON.stringify({ message: 'Native harness process exited unexpectedly', code, signal }));
      errors.close();
      fail();
    });
    if (options.signal) {
      const abort = () => { void this.close(); };
      options.signal.addEventListener('abort', abort, { once: true });
      this.child.once('exit', () => options.signal!.removeEventListener('abort', abort));
      if (options.signal.aborted) abort();
    }
  }

  public async initialize(): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'rat-environment-service', version: '1' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  }

  public call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed || this.waiting.size >= 64) return Promise.reject(new Error('Executor protocol client is unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('Executor protocol request timed out')); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) { this.reader.close(); return; }
    this.closed = true;
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Executor protocol client closed')); }
    this.waiting.clear(); this.reader.close(); this.child.stdin.destroy();
    const exited = once(this.child, 'exit').catch(() => {});
    this.child.kill('SIGTERM');
    await Promise.race([exited, delay(1000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGKILL'); await exited; }
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
