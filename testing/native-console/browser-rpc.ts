import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

/** Test client for the real MCP stdio bridge, including server-to-client requests. */
export function browserRpc(command: string, args: string[], cwd: string) {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR },
  });
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  let next = 0;
  let shutdown: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser MCP process closed')); }
    pending.clear();
  };
  child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
  reader.on('line', line => {
    const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown };
    if (message.method && message.id !== undefined) {
      send({ id: message.id, ...(message.method === 'roots/list' ? { result: { roots: [] } } : { error: { code: -32601, message: 'Unsupported client request' } }) });
      return;
    }
    const entry = message.id === undefined ? undefined : pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id!);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  return {
    notify: (method: string) => { send({ method }); },
    call: (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser MCP timeout: ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    }),
    close: () => shutdown ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) { reader.close(); fail(); return; }
      const exited = once(child, 'close');
      child.stdin.end();
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(1000)]); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      reader.close(); fail();
    })(),
  };
}
