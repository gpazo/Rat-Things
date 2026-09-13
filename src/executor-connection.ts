import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type OpenAI from 'openai';
import { environmentTokenIdentity } from './credentials/environment.js';

export interface ExecutorConnection { environment_id: string; remote_url: string; executor_key: string }

/** Stock Codex permits custom API keys at loopback. Only registry requests use this local shim. */
export async function connectExecutor(client: OpenAI, environmentId: string, options: { binary?: string; signal?: AbortSignal } = {}): Promise<void> {
  const connection = await client.post<ExecutorConnection>(`/agents/environments/${encodeURIComponent(environmentId)}/connection`);
  const remote = new URL(connection.remote_url);
  const identity = environmentTokenIdentity(connection.executor_key);
  if (remote.protocol !== 'https:' || identity?.role !== 'executor' || identity.environmentId !== environmentId || connection.environment_id !== environmentId) throw new Error('Invalid executor connection configuration');
  const proxy = await createExecutorRegistryProxy(connection);
  const child = spawn(options.binary ?? 'codex', ['exec-server', '--remote', proxy.url, '--environment-id', environmentId], {
    // AWS application credentials belong to this helper, never the executor environment.
    env: Object.fromEntries(Object.entries({
      PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
      LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, CODEX_API_KEY: connection.executor_key,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const stop = () => { child.kill('SIGTERM'); };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0 && !options.signal?.aborted) throw new Error(`Executor exited (${code ?? signal ?? 'unknown'})`);
  } finally {
    options.signal?.removeEventListener('abort', stop);
    await proxy.close();
  }
}

/** Public for deterministic transport tests; no arbitrary forward destination is accepted. */
export async function createExecutorRegistryProxy(connection: ExecutorConnection, transport: typeof fetch = fetch) {
  const endpoint = new URL(connection.remote_url);
  if (endpoint.protocol !== 'https:') throw new Error('The remote environment registry must use HTTPS');
  const allowed = new Set([`/cloud/environment/${connection.environment_id}/register`, `/cloud/environment/${connection.environment_id}/validate`]);
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method !== 'POST' || !allowed.has(path) || request.headers.authorization !== `Bearer ${connection.executor_key}`) {
        response.writeHead(403); response.end(); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 16_384) { response.writeHead(413); response.end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const result = await transport(`${endpoint.href.replace(/\/$/, '')}${path}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.executor_key}` }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(15_000),
      });
      response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Executor registry proxy did not bind');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
