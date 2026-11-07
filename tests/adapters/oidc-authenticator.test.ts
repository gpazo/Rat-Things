import { createServer } from 'node:http';
import { once } from 'node:events';
import { createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { OidcAuthenticator } from '../../src/adapters/oidc-authenticator.js';
import { parseOidcProviders, oidcLoginDiscovery, type OidcProvider } from '../../src/identity/oidc-provider.js';

const now = 1_800_000_000;
const provider: OidcProvider = { id: 'enterprise', issuer: 'https://issuer.test', jwksUri: 'https://issuer.test/jwks', clientId: 'desktop', audience: 'rat-api', profile: 'jwt_access', authorizationEndpoint: 'https://issuer.test/authorize', tokenEndpoint: 'https://issuer.test/token', redirectUri: 'http://127.0.0.1:8765/callback', scopes: ['openid', 'api.agents.read'], requiredScopes: ['rat-access'] };
async function fixture(config = provider) {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey); jwk.kid = 'key';
  const verifier = new OidcAuthenticator([config], { now: () => now * 1000, keys: () => createLocalJWKSet({ keys: [jwk] }) });
  const sign = (payload: JWTPayload = {}, typ = 'at+jwt') => new SignJWT({ iss: config.issuer, sub: 'alice', aud: 'rat-api', client_id: config.clientId, iat: now - 1, exp: now + 60, scope: 'rat-access api.agents.read', ...payload }).setProtectedHeader({ alg: 'RS256', kid: 'key', typ }).sign(pair.privateKey);
  return { verifier, sign };
}
describe('OIDC API authentication', () => {
  it('validates signed JWT access profile and keeps actor separate from ownership', async () => {
    const { verifier, sign } = await fixture();
    const result = await verifier.authenticate(`Bearer ${await sign()}`);
    expect(result).toMatchObject({ ownerId: '', authentication: 'oidc', expiresAt: (now + 60) * 1000, scopes: ['api.agents.read'], actor: { issuer: provider.issuer, subject: 'alice', kind: 'human' } });
    for (const payload of [{ iss: 'https://attacker.test' }, { aud: 'other-api' }, { client_id: 'other-client' }, { exp: now }, { nbf: now + 10 }, { sub: '' }, { scope: 'openid' }, { token_use: 'id' }, { nonce: 'id-token' }]) await expect(verifier.authenticate(`Bearer ${await sign(payload)}`)).rejects.toThrow();
    await expect(verifier.authenticate(`Bearer ${await sign({}, 'JWT')}`)).rejects.toThrow();
    const signed = await sign();
    await expect(verifier.authenticate(`Bearer ${signed.slice(0, -12)}AAAAAAAAAAAA`)).rejects.toThrow();
  });
  it('validates Cognito access tokens by token_use and exact client_id, with optional audience', async () => {
    const { audience: _audience, ...rest } = provider;
    const config = { ...rest, profile: 'cognito_access' as const, requiredScopes: [] };
    const { verifier, sign } = await fixture(config);
    expect(await verifier.authenticate(`Bearer ${await sign({ token_use: 'access', scope: 'aws.cognito.signin.user.admin' }, 'JWT')}`)).toMatchObject({ actor: { kind: 'human' } });
    for (const payload of [{ token_use: 'id' }, { token_use: 'access', client_id: 'other' }, { token_use: 'access', client_id: undefined }]) await expect(verifier.authenticate(`Bearer ${await sign(payload, 'JWT')}`)).rejects.toThrow();
  });
  it('fetches only configured JWKS and supports a new signing key', async () => {
    const first = await generateKeyPair('RS256'); const second = await generateKeyPair('RS256');
    let keys = [{ ...await exportJWK(first.publicKey), kid: 'first' }];
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys })); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
      const verifier = new OidcAuthenticator([provider], { now: () => now * 1000, keys: () => createRemoteJWKSet(new URL(`http://127.0.0.1:${address.port}/jwks`), { cooldownDuration: 0 }) });
      const sign = (key: CryptoKey, kid: string, issuer = provider.issuer) => new SignJWT({ iss: issuer, sub: 'alice', client_id: provider.clientId, aud: 'rat-api', iat: now - 1, exp: now + 60, scope: 'rat-access' }).setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' }).sign(key);
      await verifier.authenticate(`Bearer ${await sign(first.privateKey, 'first')}`);
      keys = [{ ...await exportJWK(second.publicKey), kid: 'second' }];
      await verifier.authenticate(`Bearer ${await sign(second.privateKey, 'second')}`);
      expect(requests).toBe(2);
      await expect(verifier.authenticate(`Bearer ${await sign(second.privateKey, 'second', 'http://127.0.0.1/evil')}`)).rejects.toThrow();
      expect(requests).toBe(2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rejects unsafe production configuration and exposes only safe login discovery', () => {
    expect(parseOidcProviders(JSON.stringify([provider]))).toEqual([provider]);
    for (const override of [{ issuer: 'http://localhost:1' }, { jwksUri: 'http://localhost/jwks' }, { redirectUri: 'http://localhost:8765/cb' }, { profile: 'id_token' }, { audience: undefined }, { apiScopes: ['admin'] }, { unknown: true }]) expect(() => parseOidcProviders(JSON.stringify([{ ...provider, ...override }]))).toThrow();
    expect(oidcLoginDiscovery([provider])[0]).toMatchObject({ client_id: 'desktop', jwks_uri: provider.jwksUri });
    expect(oidcLoginDiscovery([provider])[0]).not.toHaveProperty('apiScopes');
    expect(() => parseOidcProviders('[]')).toThrow();
  });
});
