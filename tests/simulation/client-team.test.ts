import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, generateKeyPair } from 'jose';
import { createAgentsFetch } from '../../src/agents-client.js';
import { beginBrowserLogin, callbackCode, discoverTeamLogin, exchangeLogin, parseLoginProvider, pkceRequest, type LoginProvider } from '../../src/client-oidc.js';
import { TeamConnectionStore } from '../../src/client-connections.js';
const provider: LoginProvider = { id: 'team', issuer: 'https://identity.example', client_id: 'desktop', jwks_uri: 'https://identity.example/keys', profile: 'jwt_access', audience: 'https://api.example', authorization_endpoint: 'https://identity.example/authorize', token_endpoint: 'https://identity.example/token', redirect_uri: 'http://127.0.0.1:43281/callback', scopes: ['openid', 'profile', 'offline_access'] };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const temporary = async () => { const path = await mkdtemp(join(tmpdir(), 'rat-team-')); directories.push(path); return path; };
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port; }
it('binds bearer tokens and space to one origin, without IAM or foreign auth headers', async () => {
  const accessToken = vi.fn(async () => 'access.secret');
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get('authorization')).toBe('Bearer access.secret');
    expect(request.headers.get('x-rat-space')).toBe('space-a');
    expect(request.headers.has('x-amz-security-token')).toBe(false);
    expect(request.redirect).toBe('error'); return Response.json({});
  });
  const api = createAgentsFetch({ baseURL: 'https://example.a1.lambda-web.us-west-2.on.aws/v1', accessToken, spaceId: 'space-a', fetch: transport });
  await api('https://example.a1.lambda-web.us-west-2.on.aws/v1/agents', { headers: { authorization: 'AWS4-HMAC-SHA256 stale', 'x-amz-security-token': 'stale', 'x-rat-space': 'untrusted' } });
  await expect(api('https://attacker.example/v1/agents')).rejects.toThrow('another origin');
  expect(accessToken).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
});
it('requires safe discovery, registered loopback callback and access-token profile', async () => {
  expect(parseLoginProvider(provider)).toEqual(provider);
  for (const override of [{ issuer: 'http://identity.example' }, { redirect_uri: 'https://attacker.example/callback' }, { redirect_uri: 'http://localhost:43281/callback' }, { profile: 'id_token' }, { scopes: ['profile'] }]) expect(() => parseLoginProvider({ ...provider, ...override })).toThrow();
  await expect(discoverTeamLogin('https://api.example/v1', async () => Response.json({ authentication: 'oidc', base_url: 'https://other.example/v1', login_providers: [provider] }))).rejects.toThrow();
});
it('uses fresh S256 proofs and rejects missing, duplicate or mismatched state', () => {
  const proof = pkceRequest(provider); const url = new URL(proof.url);
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(proof.verifier).digest('base64url'));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(pkceRequest(provider).state).not.toBe(proof.state);
  expect(callbackCode(new URL(`${provider.redirect_uri}?state=${proof.state}&code=code`), new URL(provider.redirect_uri), proof.state)).toBe('code');
  for (const suffix of ['?code=code', '?state=other&code=code', `?state=${proof.state}&state=${proof.state}&code=code`, `?state=${proof.state}&code=code&error=denied`]) expect(() => callbackCode(new URL(provider.redirect_uri + suffix), new URL(provider.redirect_uri), proof.state)).toThrow();
});
it('completes a real loopback callback and checks ID-token nonce and token binding', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const configured = { ...provider, redirect_uri: `http://127.0.0.1:${await freePort()}/callback` };
  let authorization: URL;
  const transport: typeof fetch = async (_input, init) => {
    const form = new URLSearchParams(init?.body as URLSearchParams); expect(form.get('code')).toBe('authorization-code');
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
    const id = await new SignJWT({ nonce: authorization.searchParams.get('nonce'), at_hash: createHash('sha256').update('access').digest().subarray(0, 16).toString('base64url'), name: 'Teammate' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(provider.issuer).setSubject('person-a').setAudience(provider.client_id).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 300, token_type: 'Bearer', id_token: id });
  };
  const attempt = await beginBrowserLogin(configured, { fetch: transport, key: async () => publicKey }); authorization = new URL(attempt.url);
  expect((await fetch(`${configured.redirect_uri}?state=bad&code=authorization-code`)).status).toBe(400);
  expect((await fetch(`${configured.redirect_uri}?state=${authorization.searchParams.get('state')}&code=authorization-code`)).ok).toBe(true);
  const result = await attempt.result; expect(result.identity.subject).toBe('person-a'); expect(result.tokens.refresh_token).toBe('refresh');
  const badId = await new SignJWT({ nonce: 'other' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(provider.issuer).setSubject('person-a').setAudience(provider.client_id).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await expect(exchangeLogin(provider, 'code', { verifier: 'wrong', nonce: 'wrong' }, { fetch: async () => Response.json({ access_token: 'access', expires_in: 300, token_type: 'Bearer', id_token: badId }), key: async () => publicKey })).rejects.toThrow('identity did not match');
});
it('stores secrets privately, hides them from UI state, rotates once, and checks destination', async () => {
  const directory = await temporary(); const requests: Request[] = [];
  const transport: typeof fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); return request.url === provider.token_endpoint ? Response.json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'rotated-secret', expires_in: 300 }) : Response.json({ actor: { issuer: provider.issuer, subject: 'person-a' } }); };
  const store = new TeamConnectionStore(directory, transport);
  const connection = await store.save('https://api.example/v1', provider, { identity: { issuer: provider.issuer, subject: 'person-a' }, tokens: { access_token: 'access', refresh_token: 'refresh-secret', expires_at: 0 } });
  expect(JSON.stringify(await store.list())).not.toMatch(/refresh-secret|access_token|refresh_token/);
  expect((await stat(join(directory, `${connection.id}.json`))).mode & 0o777).toBe(0o600);
  await expect(store.client({ connection_id: connection.id, endpoint: 'https://attacker.example/v1', space_id: 'space-a' })).rejects.toThrow('another team endpoint');
  expect(await Promise.all([store.accessToken(connection.id), store.accessToken(connection.id)])).toEqual(['new-access', 'new-access']);
  expect(requests.filter(r => r.url === provider.token_endpoint)).toHaveLength(1);
  expect(await readFile(join(directory, `${connection.id}.json`), 'utf8')).toContain('rotated-secret');
  await store.remove(connection.id); expect(await store.list()).toEqual([]);
});
it('rejects API identity mismatch before persisting credentials', async () => {
  const store = new TeamConnectionStore(await temporary(), async () => Response.json({ actor: { issuer: provider.issuer, subject: 'other' } }));
  await expect(store.save('https://api.example/v1', provider, { identity: { issuer: provider.issuer, subject: 'person-a' }, tokens: { access_token: 'access', expires_at: 1000 } })).rejects.toThrow('identity did not match'); expect(await store.list()).toEqual([]);
});
it('logout cannot be undone by an in-flight refresh', async () => {
  let entered!: () => void; const refreshing = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const held = new Promise<void>(resolve => { resume = resolve; });
  const store = new TeamConnectionStore(await temporary(), async (input, init) => {
    if (new Request(input, init).url === provider.token_endpoint) { entered(); await held; return Response.json({ token_type: 'Bearer', access_token: 'new-access', expires_in: 300 }); }
    return Response.json({ actor: { issuer: provider.issuer, subject: 'person-a' } });
  });
  const connection = await store.save('https://api.example/v1', provider, { identity: { issuer: provider.issuer, subject: 'person-a' }, tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: 0 } });
  const refresh = store.accessToken(connection.id); await refreshing;
  const logout = store.remove(connection.id); resume(); await refresh; await logout;
  expect(await store.list()).toEqual([]);
  await expect(store.accessToken(connection.id)).rejects.toThrow('Reconnect');
});
it('a reconnect cannot restore a connection removed during identity verification or before its callback', async () => {
  let entered!: () => void; const checking = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const held = new Promise<void>(resolve => { resume = resolve; });
  let wait = false;
  const store = new TeamConnectionStore(await temporary(), async () => {
    if (wait) { entered(); await held; }
    return Response.json({ actor: { issuer: provider.issuer, subject: 'person-a' } });
  });
  const login = { identity: { issuer: provider.issuer, subject: 'person-a' }, tokens: { access_token: 'access', expires_at: Date.now() / 1000 + 300 } };
  const connection = await store.save('https://api.example/v1', provider, login);
  wait = true;
  const reconnect = store.save(connection.endpoint, provider, login, connection.id);
  const rejected = expect(reconnect).rejects.toThrow();
  await checking; await store.remove(connection.id); resume(); await rejected;
  expect(await store.list()).toEqual([]);
  await expect(store.save(connection.endpoint, provider, login, connection.id)).rejects.toThrow();
  await expect(store.accessToken(connection.id)).rejects.toThrow('Reconnect');
});

it.each(['verification', 'callback'] as const)('logout cancels real browser reconnect while %s is pending', async phase => {
  const { ConsoleTeams } = await import('../../src/console-team.js');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const configured = { ...provider, redirect_uri: `http://127.0.0.1:${await freePort()}/callback` };
  let authorization: URL;
  let holdVerification = false;
  let entered!: () => void; const checking = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const held = new Promise<void>(resolve => { resume = resolve; });
  let finished!: () => void; const saved = new Promise<void>(resolve => { finished = resolve; });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith('/.well-known/agents-api')) return Response.json({ authentication: 'oidc', base_url: 'https://api.example/v1', login_providers: [configured] });
    if (request.url === configured.token_endpoint) {
      const id = await new SignJWT({ nonce: authorization.searchParams.get('nonce') }).setProtectedHeader({ alg: 'RS256' }).setIssuer(provider.issuer).setSubject('person-a').setAudience(provider.client_id).setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return Response.json({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', token_type: 'Bearer', expires_in: 300, id_token: id });
    }
    if (holdVerification) { entered(); await held; }
    return Response.json({ actor: { issuer: provider.issuer, subject: 'person-a' } });
  };
  const store = new TeamConnectionStore(await temporary(), transport);
  const original = await store.save('https://api.example/v1', configured, { identity: { issuer: provider.issuer, subject: 'person-a' }, tokens: { access_token: 'original', expires_at: Date.now() / 1000 + 300 } });
  const save = store.save.bind(store);
  vi.spyOn(store, 'save').mockImplementation(async (...args) => { try { return await save(...args); } finally { finished(); } });
  const teams = new ConsoleTeams(store, { discover: endpoint => discoverTeamLogin(endpoint, transport), begin: p => beginBrowserLogin(p, { fetch: transport, key: async () => publicKey }) });
  try {
    const login = await teams.route('POST', '/login', { endpoint: original.endpoint, connection_id: original.id }) as { id: string; url: string };
    authorization = new URL(login.url);
    const callback = `${configured.redirect_uri}?state=${authorization.searchParams.get('state')}&code=code`;
    if (phase === 'verification') { holdVerification = true; await fetch(callback); await checking; }
    expect(await teams.route('POST', `/connections/${original.id}/logout`, {})).toEqual({ status: 'signed_out' });
    expect(await store.list()).toEqual([]);
    if (phase === 'verification') { resume(); await saved; }
    else await expect(fetch(callback)).rejects.toThrow();
    const state = await teams.route('GET', `/login/${login.id}`, {}) as { status: string };
    expect(state.status).toBe('failed');
    expect(await store.list()).toEqual([]);
    await expect(store.accessToken(original.id)).rejects.toThrow('Reconnect');
  } finally { resume(); teams.close(); }
});
