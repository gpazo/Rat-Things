import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface LoginProvider {
  id: string; issuer: string; jwks_uri: string; client_id: string; audience?: string;
  profile: 'jwt_access' | 'cognito_access'; authorization_endpoint: string;
  token_endpoint: string; redirect_uri: string; scopes: string[];
}
export interface LoginTokens { access_token: string; refresh_token?: string; expires_at: number; }
export interface LoginIdentity { issuer: string; subject: string; label?: string; }
export interface LoginResult { tokens: LoginTokens; identity: LoginIdentity; }
export interface LoginAttempt { url: string; result: Promise<LoginResult>; close: () => void; }

function https(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid team login discovery');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Team login requires HTTPS');
  return value;
}
export function parseLoginProvider(value: unknown): LoginProvider {
  if (!value || typeof value !== 'object') throw new Error('Invalid team login provider');
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.client_id !== 'string' || !p.client_id
    || !['jwt_access', 'cognito_access'].includes(String(p.profile)) || !Array.isArray(p.scopes)
    || (p.audience !== undefined && (typeof p.audience !== 'string' || !p.audience))
    || !p.scopes.every(s => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) || !p.scopes.includes('openid')) throw new Error('Invalid team login provider');
  const redirect = new URL(String(p.redirect_uri));
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.port === '0' || redirect.username || redirect.password
    || redirect.search || redirect.hash || redirect.pathname === '/') throw new Error('Team login requires a registered loopback callback');
  return { id: p.id, issuer: https(p.issuer), jwks_uri: https(p.jwks_uri), client_id: p.client_id,
    ...(p.audience === undefined ? {} : { audience: String(p.audience) }), profile: p.profile as LoginProvider['profile'],
    authorization_endpoint: https(p.authorization_endpoint), token_endpoint: https(p.token_endpoint), redirect_uri: redirect.href, scopes: p.scopes as string[] };
}
export async function discoverTeamLogin(endpoint: string, transport = fetch): Promise<{ base_url: string; login_providers: LoginProvider[] }> {
  const base = new URL(https(endpoint));
  if (base.search || !['/', '/v1', '/v1/'].includes(base.pathname)) throw new Error('Use an Agents API URL ending in /v1');
  const response = await transport(new URL('/.well-known/agents-api', base), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Could not discover team sign-in');
  const value = await response.json() as Record<string, unknown>;
  if (value.authentication !== 'oidc' || value.base_url !== `${base.origin}/v1` || !Array.isArray(value.login_providers) || !value.login_providers.length) throw new Error('This endpoint does not offer team sign-in');
  return { base_url: `${base.origin}/v1`, login_providers: value.login_providers.map(parseLoginProvider) };
}
export function pkceRequest(provider: LoginProvider) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const url = new URL(provider.authorization_endpoint);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: provider.client_id, redirect_uri: provider.redirect_uri,
    scope: provider.scopes.join(' '), state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(provider.audience && provider.profile === 'jwt_access' ? { audience: provider.audience } : {}) })) url.searchParams.set(key, value);
  return { verifier, state, nonce, url: url.href };
}
function same(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function callbackCode(url: URL, redirect: URL, state: string): string {
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.searchParams.getAll('state').length !== 1
    || !same(url.searchParams.get('state') ?? '', state) || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.has('error')) throw new Error('Invalid sign-in callback');
  return url.searchParams.get('code')!;
}
async function tokenRequest(provider: LoginProvider, fields: Record<string, string>, transport: typeof fetch): Promise<Record<string, unknown>> {
  const response = await transport(provider.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: provider.client_id, ...fields }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Team sign-in expired or was rejected. Sign in again.');
  const value = await response.json() as Record<string, unknown>;
  if (value.token_type !== 'Bearer' || typeof value.access_token !== 'string' || !value.access_token || /\s/.test(value.access_token)
    || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0
    || (value.refresh_token !== undefined && typeof value.refresh_token !== 'string')) throw new Error('Invalid team token response');
  return value;
}
function tokens(value: Record<string, unknown>): LoginTokens {
  return { access_token: value.access_token as string, expires_at: Date.now() / 1000 + (value.expires_in as number),
    ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}) };
}
export async function exchangeLogin(provider: LoginProvider, code: string, proof: { verifier: string; nonce: string }, options: { fetch?: typeof fetch; key?: JWTVerifyGetKey } = {}): Promise<LoginResult> {
  const value = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: provider.redirect_uri, code_verifier: proof.verifier }, options.fetch ?? fetch);
  if (typeof value.id_token !== 'string') throw new Error('Team sign-in did not verify an identity');
  const { payload } = await jwtVerify(value.id_token, options.key ?? createRemoteJWKSet(new URL(provider.jwks_uri)), {
    issuer: provider.issuer, audience: provider.client_id, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], maxTokenAge: '10m',
  });
  if (payload.nonce !== proof.nonce || !payload.sub || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== provider.client_id)) throw new Error('Team sign-in identity did not match the browser request');
  if (payload.at_hash !== undefined) {
    const digest = createHash('sha256').update(value.access_token as string).digest().subarray(0, 16).toString('base64url');
    if (payload.at_hash !== digest) throw new Error('Team sign-in access token did not match the verified identity');
  }
  return { tokens: tokens(value), identity: { issuer: provider.issuer, subject: payload.sub,
    ...(typeof payload.name === 'string' ? { label: payload.name.slice(0, 160) } : {}) } };
}
export async function refreshLogin(provider: LoginProvider, current: LoginTokens, transport = fetch): Promise<LoginTokens> {
  if (!current.refresh_token) throw new Error('Team sign-in expired. Sign in again.');
  const value = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: current.refresh_token }, transport);
  return { ...tokens(value), refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : current.refresh_token };
}
export async function beginBrowserLogin(provider: LoginProvider, options: { fetch?: typeof fetch; key?: JWTVerifyGetKey; timeoutMs?: number } = {}): Promise<LoginAttempt> {
  const proof = pkceRequest(provider);
  const redirect = new URL(provider.redirect_uri);
  let server: Server;
  let timer: ReturnType<typeof setTimeout>;
  let resolve!: (value: LoginResult) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<LoginResult>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => undefined);
  let accepting = true;
  const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections(); reject(new Error('Team sign-in was cancelled')); };
  server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store'); response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    let code: string;
    try {
      if (!accepting || request.method !== 'GET' || request.headers.host !== redirect.host) throw new Error('Invalid callback');
      code = callbackCode(new URL(request.url ?? '/', redirect), redirect, proof.state);
    } catch { response.writeHead(400).end('This sign-in callback is invalid. Return to Rat Things.'); return; }
    accepting = false;
    response.end('Completing sign-in. You can return to Rat Things.');
    void exchangeLogin(provider, code, proof, options).then(resolve, reject).finally(() => { clearTimeout(timer); server.close(); });
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(Number(redirect.port), '127.0.0.1', yes); });
  timer = setTimeout(() => { accepting = false; close(); }, options.timeoutMs ?? 300_000);
  timer.unref();
  return { url: proof.url, result, close };
}
