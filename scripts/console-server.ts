#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import { isPrivateArtifactUrl } from '../src/adapters/publication-client.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const host = '127.0.0.1';
let port = boundedPort(process.env.RAT_THINGS_CONSOLE_PORT ?? '4174');
const consoleRoot = resolve(process.env.RAT_THINGS_CONSOLE_ROOT ?? 'console');
const upstreamBase = requiredApiUrl();
let authenticatedFetch: typeof fetch | undefined;

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    const message = error instanceof Error ? error.message : String(error);
    json(response, 500, { error: { code: 'console_error', message } });
  });
});

// The launcher waits for this process's bound port, never an unrelated HTTP listener.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && process.env.RAT_THINGS_CONSOLE_LAUNCHER === '1' && port !== 0) {
    port = 0;
    server.listen(port, host);
    return;
  }
  process.stderr.write(`Could not start console: ${error.code === 'EADDRINUSE' ? 'port is occupied; choose another port' : error.message}\n`);
  process.exitCode = 1;
});
server.on('listening', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('console has no TCP address');
  port = address.port;
  if (process.env.RAT_THINGS_CONSOLE_LAUNCHER === '1') {
    process.stdout.write(`${JSON.stringify({ port })}\n`);
  } else {
    process.stdout.write(`Rat Things console: http://${host}:${port}\n`);
    process.stdout.write(`Control API: ${new URL(upstreamBase).origin}\n`);
  }
});
server.listen(port, host);

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!validHost(request.headers.host)) return json(response, 403, error('forbidden', 'invalid host'));
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
  if (requestUrl.pathname.startsWith('/api/')) {
    await proxy(request, response, requestUrl);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(response, 405, error('method_not_allowed', 'only GET and HEAD are allowed for console files'));
  }
  const file = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
  if (!['index.html', 'app.js', 'markdown.js', 'marked.js', 'styles.css'].includes(file)) {
    return json(response, 404, error('not_found', 'console file not found'));
  }
  const localPath = resolve(consoleRoot, file);
  const path = file === 'marked.js' && !existsSync(localPath) ? fileURLToPath(import.meta.resolve('marked')) : localPath;
  const metadata = await stat(path);
  if (!metadata.isFile()) return json(response, 404, error('not_found', 'console file not found'));
  const body = await readFile(path);
  secureHeaders(response);
  response.statusCode = 200;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', contentType(extname(path)));
  response.setHeader('content-length', body.byteLength);
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const method = request.method;
  if (!method || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return json(response, 405, error('method_not_allowed', 'unsupported console method'));
  }
  if (!validOrigin(request.headers.origin)) {
    return json(response, 403, error('forbidden', 'cross-origin console request rejected'));
  }
  const mutation = method !== 'GET';
  if (mutation && request.headers['x-rat-console-request'] !== '1') {
    return json(response, 403, error('forbidden', 'missing console request marker'));
  }
  const upstreamPath = requestUrl.pathname.slice('/api'.length);
  if (!upstreamPath.startsWith('/v1/')) {
    return json(response, 403, error('forbidden', 'the console proxy exposes only /v1 control routes'));
  }
  const url = new URL(`${upstreamPath}${requestUrl.search}`, `${upstreamBase.replace(/\/$/, '')}/`);
  const body = mutation ? await requestBody(request) : undefined;
  const unsignedHeaders: Record<string, string> = {
    host: url.host,
    accept: 'application/json',
    'openai-beta': 'agents=v1',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(typeof request.headers['idempotency-key'] === 'string'
      ? { 'idempotency-key': request.headers['idempotency-key'] }
      : {}),
    ...(process.env.AGENT_RUNTIME_UNSIGNED === 'true' && process.env.RAT_THINGS_LOCAL_OWNER
      ? { 'x-runtime-owner': process.env.RAT_THINGS_LOCAL_OWNER }
      : {}),
  };
  let transport = fetch;
  if (process.env.AGENT_RUNTIME_UNSIGNED !== 'true') {
    const region = process.env.AWS_REGION ?? regionFromHostname(url.hostname);
    if (!region) throw new Error('AWS_REGION is required to sign console control API requests');
    const { createAgentsFetch } = await import('../src/agents-client.js');
    authenticatedFetch ??= createAgentsFetch({ baseURL: `${url.origin}/v1`, region });
    transport = authenticatedFetch;
  }
  const contentRequest = upstreamPath.endsWith('/content');
  const abort = new AbortController();
  response.once('close', () => abort.abort());
  let upstream = await transport(url, {
    method,
    headers: unsignedHeaders,
    ...(body ? { body } : {}),
    redirect: contentRequest ? 'manual' : 'error',
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(upstreamPath.endsWith('/events') ? 900_000 : 30_000)]),
  });
  if (contentRequest && isRedirect(upstream.status)) {
    const location = upstream.headers.get('location');
    if (!location) throw new Error('artifact content redirect did not include a location');
    const target = new URL(location, url);
    if (!isPrivateArtifactUrl(target, {
      controlUrl: url,
      region: process.env.AWS_REGION ?? regionFromHostname(url.hostname),
      bucket: process.env.ARTIFACT_BUCKET,
      unsigned: process.env.AGENT_RUNTIME_UNSIGNED === 'true',
    })) {
      throw new Error('artifact content redirect is not a signed regional S3 URL');
    }
    // Only the owner-authenticated control response supplies this URL. Never
    // forward its API Gateway SigV4 headers to the presigned S3 request.
    upstream = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  }
  secureHeaders(response, contentRequest);
  response.statusCode = upstream.status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
  if (upstream.headers.get('location')) response.setHeader('location', upstream.headers.get('location')!);
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) response.flushHeaders();
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), response);
  else response.end();
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function requestBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 9_000_000) throw new Error('console request body exceeds 9000000 bytes');
    chunks.push(value);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
}

function validHost(value: string | undefined): boolean {
  if (!value) return false;
  const hostname = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return hostname === host || hostname === 'localhost' || hostname === '[::1]';
}

function validOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
      origin.port === String(port);
  } catch {
    return false;
  }
}

function secureHeaders(response: ServerResponse, embeddable = false): void {
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', embeddable ? 'SAMEORIGIN' : 'DENY');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  secureHeaders(response);
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', body.byteLength);
  response.end(body);
}

function error(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function boundedPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (parsed !== 0 && parsed < 1_024) || parsed > 65_535) {
    throw new Error('RAT_THINGS_CONSOLE_PORT must be 0 or an integer from 1024 through 65535');
  }
  return parsed;
}

function requiredApiUrl(): string {
  const value = process.env.RAT_THINGS_AGENTS_API_URL ?? process.env.AGENTS_API_BASE_URL ?? process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  if (!value) throw new Error('RAT_THINGS_API_URL is required to start the local console');
  return value;
}

function regionFromHostname(hostname: string): string | undefined {
  return hostname.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/)?.[1] ?? hostname.match(/\.lambda-url\.([a-z0-9-]+)\.on\.aws$/)?.[1];
}

function contentType(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
