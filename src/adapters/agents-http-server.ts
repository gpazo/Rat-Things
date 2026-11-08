import type { ApiPrincipal } from '../domain/api-permissions.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { PerformanceScope, performanceCount, performanceHeaders, requestPerformanceOperation, responsePerformanceOutcome } from '../core/performance.js';
import { agentsWebFunctionBaseURL } from './agents-http-config.js';

/** A streaming transport keeps large requests and responses out of event payloads. */
export function createAgentsHttpServer(options: {
  baseURL?: string; webFunctionRegion?: string; issuerURL?: string; discovery?: object;
  authenticate(authorization: string | null, audience: string): Promise<ApiPrincipal>;
  route(request: Request, principal: ApiPrincipal, requestId: string): Promise<Response>;
  error(error: unknown, requestId: string): Response;
}) {
  if (!options.baseURL && !options.webFunctionRegion) throw new Error('An API base URL or Web Function region is required.');
  const staticBaseURL = options.baseURL;
  let largeRequests = 0;
  const server = createServer({ requestTimeout: 600_000, maxHeaderSize: 32_768 }, async (incoming, outgoing) => {
    const scope = new PerformanceScope(requestPerformanceOperation(incoming.method ?? 'GET', (incoming.url ?? '/').split('?')[0]!));
    await scope.run(async () => {
    const id = randomUUID();
    const abort = new AbortController();
    outgoing.once('close', () => { if (!outgoing.writableFinished) abort.abort(); });
    incoming.once('aborted', () => abort.abort());
    let reserved = false;
    try {
      const baseURL = options.webFunctionRegion
        ? agentsWebFunctionBaseURL(incoming.headers.host, options.webFunctionRegion)
        : staticBaseURL!;
      if (incoming.method === 'GET' && incoming.url === '/health') { await send(outgoing, Response.json({ status: 'ok' })); return; }
      if (incoming.method === 'GET' && incoming.url === '/.well-known/agents-api') {
        const discovery = { ...(options.discovery ?? (options.issuerURL ? { issuer_url: options.issuerURL } : {})), base_url: baseURL };
        await send(outgoing, Response.json(discovery, { headers: { 'cache-control': 'no-store' } })); return;
      }
      const owner = await options.authenticate(incoming.headers.authorization ?? null, baseURL);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const size = Number(incoming.headers['content-length'] ?? 0);
      // Node's multipart parser may hold multiple copies of a file. Bound concurrent uploads.
      if (size > 1024 * 1024 || incoming.headers['transfer-encoding']) {
        if (largeRequests >= 1) throw new AgentsApiError(429, 'Upload capacity is busy. Retry shortly.', 'rate_limit_exceeded');
        reserved = true; largeRequests++;
      }
      const body = incoming.method !== 'GET' && incoming.method !== 'HEAD' ? boundedBody(incoming, 513 * 1024 * 1024) : undefined;
      const request = new Request(new URL(incoming.url ?? '/', baseURL), {
        method: incoming.method, headers, signal: abort.signal, ...(body ? { body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      } as RequestInit);
      await send(outgoing, await options.route(request, owner, id));
    } catch (error) {
      if (outgoing.destroyed || outgoing.writableEnded) return;
      if (!outgoing.headersSent) {
        try { await send(outgoing, options.error(error, id)); }
        catch { if (!outgoing.destroyed) outgoing.destroy(); }
      } else outgoing.destroy();
    } finally {
      if (reserved) largeRequests--;
      scope.finish(!outgoing.writableFinished ? 'aborted' : responsePerformanceOutcome(outgoing.statusCode));
    }
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 900_000;
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
  performanceHeaders();
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    performanceCount('ResponseBytes', chunk.length); callback(null, chunk);
  } }), outgoing);
  else {
    const completion = finished(outgoing, { cleanup: true });
    outgoing.end();
    await completion;
  }
}
