import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export function rpcClient(child: ChildProcessWithoutNullStreams) {
  let id = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const pending = typeof value.id === 'number' ? waiting.get(value.id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(value.id as number);
    if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
    else pending.resolve(value.result);
  });
  return {
    call: (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { waiting.delete(key); reject(new Error(`RPC timed out: ${method}`)); }, 5000);
      waiting.set(key, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
    }),
    close: () => { reader.close(); for (const pending of waiting.values()) clearTimeout(pending.timer); waiting.clear(); },
  };
}
