import OpenAI from 'openai';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

// The SDK owns request deadlines. Node's independent five-minute header deadline
// must not preempt the API's five-minute environment admission response.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const sdkFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  return undiciFetch(request.url, { method: request.method, headers,
    ...(request.body ? { body: request.body as unknown as NonNullable<UndiciRequestInit['body']> } : {}), signal: request.signal,
    redirect: request.redirect, duplex: 'half', dispatcher,
  }) as unknown as Promise<Response>;
};

/** Use the upstream client with the deployment's IAM identity and native streaming fetch. */
export function createAgentsClient(options: Parameters<typeof createAgentsFetch>[0]): OpenAI {
  return new OpenAI({ apiKey: 'aws-sigv4', baseURL: options.baseURL, fetch: createAgentsFetch(options) });
}

export function createAgentsFetch(options: {
  baseURL: string;
  region: string;
  credentials?: ConstructorParameters<typeof SignatureV4>[0]['credentials'];
  fetch?: typeof fetch;
  tokenIssuerURL?: string;
}): typeof fetch {
  const endpoint = new URL(options.baseURL);
  if (endpoint.protocol !== 'https:') throw new Error('The Agents API endpoint must use HTTPS');
  const signer = new SignatureV4({
    service: endpoint.hostname.includes('.lambda-url.') ? 'lambda' : 'execute-api',
    region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256,
  });
  const transport = options.fetch ?? sdkFetch;
  const iamEndpoint = /\.(lambda-url\.[a-z0-9-]+\.on\.aws|execute-api\.[a-z0-9-]+\.amazonaws\.com)$/.test(endpoint.hostname);
  let token: { api_key: string; expires_at: number } | undefined;
  let pendingToken: Promise<void> | undefined;
  const authorize = async () => {
    if (token && token.expires_at > Date.now() / 1000 + 60) return token.api_key;
    pendingToken ??= (async () => {
      const issuer = options.tokenIssuerURL ?? await discoverIssuer(transport, endpoint);
      const url = new URL(issuer);
      if (url.protocol !== 'https:' || url.hostname !== `${url.hostname.split('.')[0]}.lambda-url.${options.region}.on.aws` || url.pathname !== '/v1/auth/tokens' || url.search || url.hash || url.username || url.password) throw new Error('The API token issuer must be an AWS Lambda URL in the configured region');
      const issuerSigner = new SignatureV4({ service: 'lambda', region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
      const signed = await issuerSigner.sign(new HttpRequest({ protocol: 'https:', hostname: url.hostname, path: url.pathname, method: 'POST', headers: { host: url.host, 'content-type': 'application/json' }, body: '{}' }));
      const result = await transport(url, { method: 'POST', headers: signed.headers, body: '{}', redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!result.ok) throw new Error('API key issuance failed');
      const value: unknown = await result.json();
      if (typeof value !== 'object' || value === null || !('api_key' in value) || typeof value.api_key !== 'string' || !('expires_at' in value) || typeof value.expires_at !== 'number' || !('base_url' in value) || value.base_url !== options.baseURL.replace(/\/$/, '')) throw new Error('Invalid API key issuance response');
      token = { api_key: value.api_key, expires_at: value.expires_at };
    })().finally(() => { pendingToken = undefined; });
    await pendingToken;
    return token!.api_key;
  };
  return async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== endpoint.origin) throw new Error('The Agents client cannot sign requests for another origin');
      if (!iamEndpoint || options.tokenIssuerURL) {
        const headers = new Headers(request.headers);
        headers.set('authorization', `Bearer ${await authorize()}`);
        const result = await transport(new Request(request, { headers, redirect: 'error' }));
        if (result.status === 401) token = undefined;
        return result;
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { if (key !== 'authorization') headers[key] = value; });
      headers.host = url.host;
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
      const query: Record<string, string | string[]> = {};
      for (const key of url.searchParams.keys()) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length > 1 ? values : values[0]!;
      }
      const signed = await signer.sign(new HttpRequest({ protocol: url.protocol, hostname: url.hostname, ...(url.port ? { port: Number(url.port) } : {}), path: url.pathname, method: request.method, headers, query, ...(body ? { body } : {}) }));
      return transport(request.url, { method: request.method, headers: signed.headers, signal: request.signal, redirect: 'error', ...(body ? { body } : {}) });
  };
}

async function discoverIssuer(transport: typeof fetch, endpoint: URL): Promise<string> {
  const response = await transport(new URL('/.well-known/agents-api', endpoint), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('API authentication discovery failed');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || !('issuer_url' in value) || typeof value.issuer_url !== 'string') throw new Error('Invalid API authentication discovery');
  return value.issuer_url;
}
