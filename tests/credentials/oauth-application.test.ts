import { describe, expect, it } from 'vitest';
import { oauthApplication } from '../../src/credentials/oauth-application.js';

describe('OAuth application credential values', () => {
  it('projects only app credentials from a supplied value without modifying it', () => {
    const value = Object.freeze({ client_id: 'id', client_secret: 'secret', ignored: 'metadata' });
    expect(oauthApplication(value, 'slack')).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(value.ignored).toBe('metadata');
  });

  it('distinguishes invalid containers from missing or invalid credential fields', () => {
    for (const value of [undefined, null, false, [], 'secret']) {
      expect(() => oauthApplication(value, 'slack')).toThrow('OAuth application secret for slack is invalid');
    }
    for (const value of [{}, { client_id: '', client_secret: 'secret' }, { client_id: 'id', client_secret: false }]) {
      expect(() => oauthApplication(value, 'slack')).toThrow('requires client_id and client_secret');
    }
  });

  it('applies UTF-8 byte limits while preserving valid whitespace', () => {
    const value = { client_id: 'é'.repeat(1_024), client_secret: 'é'.repeat(4_096) };
    expect(oauthApplication(value, 'slack')).toEqual({ clientId: value.client_id, clientSecret: value.client_secret });
    expect(() => oauthApplication({ ...value, client_id: `${value.client_id}é` }, 'slack')).toThrow('requires client_id and client_secret');
    expect(() => oauthApplication({ ...value, client_secret: `${value.client_secret}é` }, 'slack')).toThrow('requires client_id and client_secret');
    expect(oauthApplication({ client_id: ' ', client_secret: ' ' }, 'slack')).toEqual({ clientId: ' ', clientSecret: ' ' });
  });
});
