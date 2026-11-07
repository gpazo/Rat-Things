import { afterEach, expect, it, vi } from 'vitest';
import { getTeamAuthentication, agentsApiDiscovery } from '../../src/app/composition.js';

afterEach(() => vi.unstubAllEnvs());
it('leaves an empty provider list disabled in IAM mode and fails closed in OIDC mode', () => {
  vi.stubEnv('TEAM_OIDC_PROVIDERS_JSON', '[]');
  vi.stubEnv('AGENTS_AUTH_MODE', 'iam');
  expect(getTeamAuthentication()).toBeUndefined();
  vi.stubEnv('AGENTS_AUTH_MODE', 'oidc');
  expect(() => getTeamAuthentication()).toThrow('at least one provider');
});
it('exposes safe login discovery without composing execution or publishing API grants', () => {
  vi.stubEnv('AGENTS_AUTH_MODE', 'oidc');
  vi.stubEnv('AGENTS_PUBLIC_BASE_URL', 'https://api.test/v1');
  vi.stubEnv('TEAM_OIDC_PROVIDERS_JSON', JSON.stringify([{ id: 'test', issuer: 'https://identity.test', jwksUri: 'https://identity.test/jwks',
    clientId: 'desktop', profile: 'jwt_access', audience: 'rat-api', authorizationEndpoint: 'https://identity.test/authorize', tokenEndpoint: 'https://identity.test/token',
    redirectUri: 'http://127.0.0.1:8765/callback', scopes: ['openid'], apiScopes: ['api.agents.read'], requiredScopes: ['private-api-scope'] }]));
  const discovery = agentsApiDiscovery();
  expect(discovery).toMatchObject({ authentication: 'oidc', base_url: 'https://api.test/v1', login_providers: [{ id: 'test', client_id: 'desktop' }] });
  expect(JSON.stringify(discovery)).not.toContain('private-api-scope');
  expect(JSON.stringify(discovery)).not.toContain('api.agents.read');
});
