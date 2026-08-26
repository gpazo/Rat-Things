#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

const host = '127.0.0.1';
const port = boundedPort(process.env.RAT_THINGS_CONSOLE_PORT ?? '4174');
const consoleRoot = resolve('console');
const upstreamBase = requiredApiUrl();

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    json(response, 500, { error: { code: 'console_error', message } });
  });
});

server.listen(port, host, () => {
  process.stdout.write(`Rat Things console: http://${host}:${port}\n`);
  process.stdout.write(`Control API: ${new URL(upstreamBase).origin}\n`);
});

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
  if (!['index.html', 'app.js', 'styles.css'].includes(file)) {
    return json(response, 404, error('not_found', 'console file not found'));
  }
  const path = resolve(consoleRoot, file);
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
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(response, 405, error('method_not_allowed', 'the console proxy allows GET and POST only'));
  }
  if (!validOrigin(request.headers.origin)) {
    return json(response, 403, error('forbidden', 'cross-origin console request rejected'));
  }
  if (request.method === 'POST' && request.headers['x-rat-console-request'] !== '1') {
    return json(response, 403, error('forbidden', 'missing console request marker'));
  }
  const upstreamPath = requestUrl.pathname.slice('/api'.length);
  if (!upstreamPath.startsWith('/v1/')) {
    return json(response, 403, error('forbidden', 'the console proxy exposes only /v1 control routes'));
  }
  const url = new URL(`${upstreamPath}${requestUrl.search}`, `${upstreamBase.replace(/\/$/, '')}/`);
  const body = request.method === 'POST' ? await requestBody(request) : undefined;
  const unsignedHeaders: Record<string, string> = {
    host: url.host,
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(typeof request.headers['idempotency-key'] === 'string'
      ? { 'idempotency-key': request.headers['idempotency-key'] }
      : {}),
    ...(process.env.AGENT_RUNTIME_UNSIGNED === 'true' && process.env.RAT_THINGS_LOCAL_OWNER
      ? { 'x-runtime-owner': process.env.RAT_THINGS_LOCAL_OWNER }
      : {}),
  };
  let headers = unsignedHeaders;
  if (process.env.AGENT_RUNTIME_UNSIGNED !== 'true') {
    const region = process.env.AWS_REGION ?? regionFromHostname(url.hostname);
    if (!region) throw new Error('AWS_REGION is required to sign console control API requests');
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: 'execute-api',
      sha256: Sha256,
    });
    const signed = await signer.sign(new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: unsignedHeaders,
      ...(body ? { body } : {}),
    }));
    headers = signed.headers;
  }
  const contentRequest = upstreamPath.endsWith('/content');
  let upstream = await fetch(url, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
    redirect: contentRequest ? 'manual' : 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  let redirectHops = 0;
  while (contentRequest && isRedirect(upstream.status)) {
    if (redirectHops >= 2) throw new Error('artifact content redirect chain is too long');
    const location = upstream.headers.get('location');
    if (!location) throw new Error('artifact content redirect did not include a location');
    const target = new URL(location, url);
    const kind = artifactRedirectKind(target, url);
    if (!kind) {
      throw new Error('artifact content redirect left the configured private artifact bucket');
    }
    // The control request is SigV4-signed for API Gateway. Never forward those
    // headers to either the opaque share grant or its presigned S3 request.
    upstream = await fetch(target, {
      method: 'GET',
      redirect: kind === 'share' ? 'manual' : 'error',
      signal: AbortSignal.timeout(30_000),
    });
    redirectHops += 1;
  }
  const result = new Uint8Array(await upstream.arrayBuffer());
  secureHeaders(response, contentRequest);
  response.statusCode = upstream.status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
  if (upstream.headers.get('location')) response.setHeader('location', upstream.headers.get('location')!);
  response.setHeader('content-length', result.byteLength);
  response.end(result);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function artifactRedirectKind(target: URL, controlUrl: URL): 'share' | 'storage' | undefined {
  if (process.env.AGENT_RUNTIME_UNSIGNED === 'true') {
    return target.origin === controlUrl.origin ? 'storage' : undefined;
  }
  if (
    target.origin === controlUrl.origin &&
    /^\/v1\/shares\/[a-f0-9]{32}-[a-f0-9]{64}$/.test(target.pathname) &&
    !target.search &&
    !target.hash
  ) {
    return 'share';
  }
  const region = process.env.AWS_REGION ?? regionFromHostname(controlUrl.hostname);
  const bucket = process.env.ARTIFACT_BUCKET;
  if (!region || !bucket || target.protocol !== 'https:') return undefined;
  if (target.hostname !== `${bucket}.s3.${region}.amazonaws.com`) return undefined;
  return target.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    Boolean(target.searchParams.get('X-Amz-Signature'))
    ? 'storage'
    : undefined;
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
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new Error('RAT_THINGS_CONSOLE_PORT must be an integer from 1024 through 65535');
  }
  return parsed;
}

function requiredApiUrl(): string {
  const value = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  if (!value) throw new Error('RAT_THINGS_API_URL is required to start the local console');
  return value;
}

function regionFromHostname(hostname: string): string | undefined {
  return hostname.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/)?.[1];
}

function contentType(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
