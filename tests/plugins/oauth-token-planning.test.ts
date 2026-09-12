import { describe, expect, it } from 'vitest';
import {
  oauthTokenRequest, oauthTokenResponse, tokenNeedsRefresh, tokenPrefixes,
} from '../../src/plugins/oauth-token-planning.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';
import { fixedClock, registry, secondaryRegistry } from './oauth-fixtures.js';

const definition = registry().plugin('slack').manifest.authentication[0]!.oauth2!;

function response(text: string, status = 200) {
  return {
    pluginTitle: 'Slack', definition, text, status, ok: status >= 200 && status < 300, now: fixedClock.now(),
  };
}

describe('OAuth token request planning', () => {
  it('encodes Basic client authentication while retaining the original form parameters', () => {
    const parameters = Object.freeze({ grant_type: 'refresh_token', refresh_token: 'refresh & value' });
    const application = Object.freeze({ clientId: 'id :+é', clientSecret: 'secret/& =' });
    const result = oauthTokenRequest({
      definition: { ...definition, tokenEndpointAuthMethod: 'client-secret-basic' }, application, parameters,
    });

    expect(Buffer.from(result.headers.authorization!.slice('Basic '.length), 'base64').toString('utf8'))
      .toBe('id+%3A%2B%C3%A9:secret%2F%26+%3D');
    expect(result.body).toBe('grant_type=refresh_token&refresh_token=refresh+%26+value');
    expect(new URLSearchParams(result.body).has('client_secret')).toBe(false);
    expect(parameters.refresh_token).toBe('refresh & value');
  });

  it('replaces client credentials in post forms without modifying the input record', () => {
    const parameters = Object.freeze({ client_id: 'old', code: '', client_secret: 'old-secret' });
    const result = oauthTokenRequest({ definition, parameters, application: { clientId: 'new-id', clientSecret: 'new-secret' } });

    expect(result.body).toBe('client_id=new-id&code=&client_secret=new-secret');
    expect(result.headers).toEqual({ accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' });
    expect(parameters.client_secret).toBe('old-secret');
  });
});

describe('OAuth token response projection', () => {
  it('projects primary and delegated tokens with independent fields and explicit expiration time', () => {
    const input = response(JSON.stringify({
      access_token: 'bot-token', refresh_token: 'bot-refresh', expires_in: '3600.9', token_type: 'bot', scope: '',
      authed_user: { access_token: 'user-token', refresh_token: 'user-refresh', scope: 'search:read', expires_in: 1800 },
    }));
    const result = oauthTokenResponse({
      ...input, definition: secondaryRegistry().plugin('slack').manifest.authentication[0]!.oauth2!, includeSecondaryToken: true,
    });

    expect(result).toEqual({
      access_token: 'bot-token', refresh_token: 'bot-refresh', token_type: 'bot', expires_at: '2026-08-27T21:00:00.000Z',
      user_access_token: 'user-token', user_refresh_token: 'user-refresh', user_scope: 'search:read', user_expires_at: '2026-08-27T20:30:00.000Z',
    });
    expect(input.now.toISOString()).toBe('2026-08-27T20:00:00.000Z');
  });

  it('projects a delegated refresh without requiring another nested token', () => {
    const result = oauthTokenResponse({
      ...response(JSON.stringify({ access_token: 'new-user', token_type: '', refresh_token: null, expires_in: '' })),
      definition: secondaryRegistry().plugin('slack').manifest.authentication[0]!.oauth2!, credentialPrefix: 'user',
    });
    expect(result).toEqual({ user_access_token: 'new-user' });
  });

  it('validates the primary token before checking the requested delegated token', () => {
    const input = { ...response('{}'), definition: secondaryRegistry().plugin('slack').manifest.authentication[0]!.oauth2!, includeSecondaryToken: true };
    expect(() => oauthTokenResponse(input)).toThrow('OAuth access token is missing or invalid');
    expect(() => oauthTokenResponse({ ...input, text: '{"access_token":"primary"}' }))
      .toThrow('did not issue the requested delegated user token');
  });

  it.each(['', 'not-json', 'null', '[]', 'false'])('classifies malformed response %s before HTTP rejection', (text) => {
    expect(() => oauthTokenResponse(response(text, 400))).toThrow(IntegrationProviderUnavailableError);
  });

  it('distinguishes provider rejection from temporary HTTP failures without exposing response details', () => {
    const text = '{"error":"private-provider-detail"}';
    for (const status of [429, 500, 503]) {
      expect(() => oauthTokenResponse(response(text, status))).toThrow(IntegrationProviderUnavailableError);
    }
    for (const status of [200, 400, 401]) {
      expect(() => oauthTokenResponse(response(text, status))).toThrow('Slack rejected the OAuth token exchange');
    }
    expect(() => oauthTokenResponse(response('{"error":"","access_token":"token"}')))
      .toThrow('rejected the OAuth token exchange');
    expect(() => oauthTokenResponse(response('{"ok":false,"access_token":"token"}')))
      .toThrow('rejected the OAuth token exchange');
    expect(oauthTokenResponse(response('{"ok":0,"access_token":"token"}'))).toEqual({ access_token: 'token' });
  });

  it('accepts the response byte limit and rejects excess bytes before inspecting token fields', () => {
    const json = '{"access_token":"token"}';
    const text = json + ' '.repeat(64 * 1024 - Buffer.byteLength(json));
    expect(oauthTokenResponse(response(text))).toEqual({ access_token: 'token' });
    expect(() => oauthTokenResponse(response(`${text} `, 400))).toThrow(IntegrationProviderUnavailableError);
  });

  it('enforces token and scope limits by UTF-8 bytes', () => {
    const access_token = 'é'.repeat(16_384);
    expect(oauthTokenResponse(response(JSON.stringify({ access_token })))).toEqual({ access_token });
    expect(() => oauthTokenResponse(response(JSON.stringify({ access_token: `${access_token}é` }))))
      .toThrow('OAuth access token is missing or invalid');
    expect(() => oauthTokenResponse(response(JSON.stringify({ access_token: 'token', scope: 'é'.repeat(8_193) }))))
      .toThrow('OAuth scope is missing or invalid');
  });

  it('preserves expiry coercion, range checks, and absent values', () => {
    for (const expires_in of [undefined, null, '']) {
      expect(oauthTokenResponse(response(JSON.stringify({ access_token: 'token', expires_in })))).toEqual({ access_token: 'token' });
    }
    for (const expires_in of [0, false, -1, 'invalid', 0.9, 366 * 24 * 60 * 60 + 1]) {
      expect(() => oauthTokenResponse(response(JSON.stringify({ access_token: 'token', expires_in })))).toThrow('expires_in is invalid');
    }
    expect(oauthTokenResponse(response('{"access_token":"token","expires_in":true}')).expires_at)
      .toBe('2026-08-27T20:00:01.000Z');
  });
});

describe('OAuth refresh decisions', () => {
  it('refreshes at the inclusive leeway boundary and treats a malformed expiry as due', () => {
    const now = fixedClock.now();
    expect(tokenNeedsRefresh({}, now)).toBe(false);
    expect(tokenNeedsRefresh({ expires_at: '' }, now)).toBe(false);
    expect(tokenNeedsRefresh({ expires_at: 'invalid' }, now)).toBe(true);
    expect(tokenNeedsRefresh({ expires_at: '2026-08-27T20:02:00.000Z' }, now)).toBe(true);
    expect(tokenNeedsRefresh({ expires_at: '2026-08-27T20:02:00.001Z' }, now)).toBe(false);
    expect(tokenNeedsRefresh({ expires_at: 'invalid', user_expires_at: '2026-08-27T22:00:00.000Z' }, now, 'user')).toBe(false);
    expect(now.toISOString()).toBe('2026-08-27T20:00:00.000Z');
  });

  it('lists primary then delegated tokens in a fresh array', () => {
    const definition = secondaryRegistry().plugin('slack').manifest.authentication[0]!.oauth2!;
    const prefixes = tokenPrefixes(definition);
    expect(prefixes).toEqual(['', 'user']);
    prefixes.reverse();
    expect(tokenPrefixes(definition)).toEqual(['', 'user']);
  });
});
