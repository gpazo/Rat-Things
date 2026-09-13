import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AgentsApiError } from '../domain/agents-api-validation.js';

/** A streaming HTTP transport avoids Lambda's request-size and invocation-duration limits. */
export function createAgentsHttpServer(options: {
  baseURL: string; issuerURL: string;
  authenticate(authorization: string | null): Promise<string>;
  route(request: Request, ownerId: string, requestId: string): Promise<Response>;
  error(error: unknown, requestId: string): Response;
}) {
  const origin = new URL(options.baseURL).origin;
  let largeRequests = 0;
  const server = createServer({ requestTimeout: 600_000, maxHeaderSize: 32_768 }, async (incoming, outgoing) => {
    const id = randomUUID();
    const abort = new AbortController();
    outgoing.once('close', () => abort.abort());
    let reserved = false;
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') { await send(outgoing, Response.json({ status: 'ok' })); return; }
      if (incoming.method === 'GET' && incoming.url === '/.well-known/agents-api') { await send(outgoing, Response.json({ issuer_url: options.issuerURL, base_url: options.baseURL }, { headers: { 'cache-control': 'no-store' } })); return; }
      const owner = await options.authenticate(incoming.headers.authorization ?? null);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const size = Number(incoming.headers['content-length'] ?? 0);
      // Node's multipart parser may hold multiple copies of a file. Bound concurrent uploads.
      if (size > 1024 * 1024 || incoming.headers['transfer-encoding']) {
        if (largeRequests >= 2) throw new AgentsApiError(429, 'Upload capacity is busy. Retry shortly.', 'rate_limit_exceeded');
        reserved = true; largeRequests++;
      }
      const body = incoming.method !== 'GET' && incoming.method !== 'HEAD' ? boundedBody(incoming, 513 * 1024 * 1024) : undefined;
      const request = new Request(new URL(incoming.url ?? '/', origin), {
        method: incoming.method, headers, signal: abort.signal, ...(body ? { body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      } as RequestInit);
      await send(outgoing, await options.route(request, owner, id));
    } catch (error) {
      if (!outgoing.headersSent) await send(outgoing, options.error(error, id));
      else outgoing.destroy();
    } finally { if (reserved) largeRequests--; }
  });
  server.headersTimeout = 30_000;
  return server;
}

function boundedBody(incoming: IncomingMessage, maximum: number) {
  let size = 0;
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    callback(size > maximum ? new AgentsApiError(413, 'Request body is too large.', 'invalid_request') : null, chunk);
  } });
  incoming.on('error', (error) => stream.destroy(error));
  return incoming.pipe(stream);
}
async function send(outgoing: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  outgoing.writeHead(response.status, headers);
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), outgoing);
  else outgoing.end();
}
