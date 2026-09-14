import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export function rpcClient(child: ChildProcessWithoutNullStreams) {
  let id = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const reader = createInterface({ input: child.stdout });
  let closed: Error | undefined;
  const fail = (error: Error) => {
    if (closed) return;
    closed = error;
    reader.close();
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
    waiting.clear();
  };
  // Wait for close so buffered final responses are consumed before pending calls fail.
  child.once('close', (code, signal) => fail(new Error(`RPC process closed (${signal ?? `exit ${code}`})`)));
  child.once('error', () => fail(new Error('RPC process failed to start')));
  child.stdin.on('error', () => fail(new Error('RPC input closed')));
  reader.on('line', (line) => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const pending = typeof value.id === 'number' ? waiting.get(value.id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(value.id as number);
    if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
    else pending.resolve(value.result);
  });
  return {
    call: (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      if (closed) { reject(closed); return; }
      const key = ++id;
      const timer = setTimeout(() => { waiting.delete(key); reject(new Error(`RPC timed out: ${method}`)); }, 5000);
      waiting.set(key, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
    }),
    close: () => fail(new Error('RPC client closed')),
  };
}
