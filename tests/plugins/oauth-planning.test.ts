import { describe, expect, it } from 'vitest';
import {
  oauthAuthorizationRecord, oauthAuthorizationUrl, oauthCodeChallenge, trustedCallbackUrl,
  parseOAuthApplicationSecretArns,
} from '../../src/plugins/oauth-planning.js';
import { registry, secondaryRegistry } from './oauth-fixtures.js';

const callbackUrl = 'https://api.example.test/v1/integrations/oauth/callback';

describe('OAuth authorization planning', () => {
  it('constructs bounded state from explicit values and retains empty grant narrowing', () => {
    const grant = { preset: 'custom' as const, allowOperations: [], denyOperations: [], resourceConstraints: {} };
    Object.freeze(grant);
    const input = Object.freeze({ ownerId: 'api:owner-1', pluginId: 'slack', callbackUrl, alias: '', grant });
    const now = new Date('2026-08-27T20:00:00.999Z');
    const record = oauthAuthorizationRecord(input, callbackUrl, 'verifier', now);

    expect(record).toEqual({
      version: '1', ownerId: input.ownerId, pluginId: 'slack', callbackUrl, codeVerifier: 'verifier', grant,
      createdAt: '2026-08-27T20:00:00.999Z', expiresAt: 1_787_861_400,
    });
    expect(record.grant).toBe(grant);
    expect(now.toISOString()).toBe('2026-08-27T20:00:00.999Z');
    expect(oauthAuthorizationRecord({ ...input, reconnectConnectionId: 'connection-1' }, callbackUrl, 'verifier', now))
      .toHaveProperty('reconnectConnectionId', 'connection-1');
  });

  it('builds independent authorization URLs with the configured scopes and custom parameters', () => {
    const definition = secondaryRegistry().plugin('slack').manifest.authentication[0]!.oauth2!;
    definition.authorizationUrl += '?keep=value';
    definition.authorizationParameters = { prompt: 'consent' };
    definition.scopes = ['chat:write', 'channels:read'];
    definition.scopeSeparator = ',';
    const before = structuredClone(definition);
    Object.freeze(definition);
    const result = new URL(oauthAuthorizationUrl({ definition, clientId: 'client id', callbackUrl, state: 'state', codeChallenge: 'challenge' }));

    expect(result.search).toBe('?keep=value&response_type=code&client_id=client+id&redirect_uri=https%3A%2F%2Fapi.example.test%2Fv1%2Fintegrations%2Foauth%2Fcallback&state=state&code_challenge=challenge&code_challenge_method=S256&scope=chat%3Awrite%2Cchannels%3Aread&user_scope=search%3Aread&prompt=consent');
    expect(definition).toEqual(before);
  });

  it('retains an explicit empty scope list and derives a stable PKCE challenge', () => {
    const definition = { ...registry().plugin('slack').manifest.authentication[0]!.oauth2!, scopes: [] };
    const challenge = oauthCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const url = new URL(oauthAuthorizationUrl({ definition, clientId: 'id', callbackUrl, state: 'state', codeChallenge: challenge }));
    expect(url.searchParams.get('scope')).toBe('');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('accepts only credential-free HTTPS callback URLs at the fixed path', () => {
    expect(trustedCallbackUrl(callbackUrl).href).toBe(callbackUrl);
    for (const value of [
      callbackUrl.replace('https:', 'http:'), `${callbackUrl}?state=x`, `${callbackUrl}#fragment`,
      callbackUrl.replace('api.example', 'user:pass@api.example'), `${callbackUrl}/`,
    ]) {
      expect(() => trustedCallbackUrl(value)).toThrow('OAuth callback URL is invalid');
    }
    expect(() => trustedCallbackUrl('not a URL')).toThrow(TypeError);
  });

  it('preserves empty configuration separately from malformed configuration', () => {
    expect(parseOAuthApplicationSecretArns(undefined)).toEqual({});
    expect(parseOAuthApplicationSecretArns('')).toEqual({});
    expect(() => parseOAuthApplicationSecretArns(' ')).toThrow('must be valid JSON');
    for (const value of ['null', '[]', 'false']) {
      expect(() => parseOAuthApplicationSecretArns(value)).toThrow('must be a JSON object');
    }
    const reference = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:oauth/slack-abcd';
    expect(parseOAuthApplicationSecretArns(JSON.stringify({ slack: reference }))).toEqual({ slack: reference });
    expect(() => parseOAuthApplicationSecretArns(JSON.stringify({ slack: `${reference} ` }))).toThrow('invalid entry');
  });
});
