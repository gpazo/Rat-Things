import { describe, expect, it, vi } from 'vitest';
import {
  OAuthAuthorizationService,
  OAuthRefreshingCredentialBroker,
  SecretOAuthApplicationRegistry,
  type OAuthAuthorizationServiceOptions,
  type OAuthRefreshingCredentialBrokerOptions,
} from '../../src/plugins/oauth.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';
import {
  applications, connection, fixedClock, MemoryOAuthStore, oauthConnections,
  registry, secondaryRegistry,
} from './oauth-fixtures.js';

const startInput = {
  ownerId: 'api:owner-1', pluginId: 'slack',
  callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
  grant: { preset: 'read-only' } as const,
};

function authorizationOptions(): OAuthAuthorizationServiceOptions {
  return {
    registry: registry(), applications: applications(), store: new MemoryOAuthStore(),
    connections: oauthConnections(vi.fn()), clock: fixedClock,
    randomBytes: (size) => Buffer.alloc(size, 1),
  };
}

const expired = {
  access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '2026-08-27T19:59:00.000Z',
};

function refreshOptions(): OAuthRefreshingCredentialBrokerOptions {
  return {
    credentials: { readRecord: vi.fn().mockResolvedValue(Object.freeze({ ...expired })) },
    vault: { replace: vi.fn() }, registry: registry(), applications: applications(),
    store: new MemoryOAuthStore(), clock: fixedClock, randomId: () => 'lock-1', sleep: vi.fn(),
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }))),
  };
}

describe('OAuth authorization effects', () => {
  it('validates the callback before secret reads, randomness, or state writes', async () => {
    const options = authorizationOptions();
    const random = vi.fn(options.randomBytes);
    const create = vi.spyOn(options.store, 'create');
    const service = new OAuthAuthorizationService({ ...options, randomBytes: random });

    await expect(service.start({ ...startInput, callbackUrl: 'http://untrusted.example/callback' }))
      .rejects.toThrow('callback URL is invalid');
    expect(options.applications.application).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('reads the app, generates state and verifier, reads time, then stores state', async () => {
    const events: string[] = [];
    const options = authorizationOptions();
    const application = options.applications.application;
    options.applications.application = async (pluginId) => { events.push('app'); return application(pluginId); };
    options.randomBytes = (size) => { events.push(`random:${size}`); return Buffer.alloc(size, 1); };
    options.clock = { now: () => { events.push('clock'); return fixedClock.now(); } };
    options.store.create = async () => { events.push('store'); };

    await new OAuthAuthorizationService(options).start(startInput);
    expect(events).toEqual(['app', 'random:32', 'random:64', 'clock', 'store']);
  });

  it('stores state before constructing the provider URL', async () => {
    const options = authorizationOptions();
    options.registry.plugin('slack').manifest.authentication[0]!.oauth2!.authorizationUrl = 'invalid-url';
    const create = vi.spyOn(options.store, 'create');

    await expect(new OAuthAuthorizationService(options).start(startInput)).rejects.toThrow('Invalid URL');
    expect(create).toHaveBeenCalledOnce();
  });

  it('consumes declined state once and checks expiration before provider errors', async () => {
    const options = authorizationOptions();
    const now = vi.fn(fixedClock.now);
    const fetcher = vi.fn();
    const service = new OAuthAuthorizationService({ ...options, clock: { now }, fetch: fetcher });
    const started = await service.start(startInput);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    now.mockClear();

    await expect(service.complete({ state, providerError: 'denied' })).rejects.toThrow('provider declined');
    expect(now).toHaveBeenCalledOnce();
    await expect(service.complete({ state, providerError: 'denied' })).rejects.toThrow('invalid or expired');
    expect(now).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();

    await service.start(startInput);
    now.mockReturnValue(new Date(started.expiresAt));
    await expect(service.complete({ state, providerError: 'denied' })).rejects.toThrow('invalid or expired');
  });

  it('does not consume malformed state or read time for absent state', async () => {
    const options = authorizationOptions();
    const now = vi.fn(fixedClock.now);
    const consume = vi.spyOn(options.store, 'consume');
    const service = new OAuthAuthorizationService({ ...options, clock: { now } });

    await expect(service.complete({ state: 'short', code: 'code' })).rejects.toThrow('invalid or expired');
    expect(consume).not.toHaveBeenCalled();
    await expect(service.complete({ state: 'a'.repeat(43), code: 'code' })).rejects.toThrow('invalid or expired');
    expect(consume).toHaveBeenCalledOnce();
    expect(now).not.toHaveBeenCalled();
  });

  it('keeps failed token exchanges consumed and redacts the provider response', async () => {
    const options = authorizationOptions();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'secret-provider-detail' }), { status: 400 }));
    const service = new OAuthAuthorizationService({ ...options, fetch: fetcher });
    const started = await service.start(startInput);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    await expect(service.complete({ state, code: 'code' })).rejects.toThrow('Slack rejected the OAuth token exchange');
    await expect(service.complete({ state, code: 'retry' })).rejects.toThrow('invalid or expired');
    expect(options.connections.create).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('OAuth refresh effects', () => {
  it('returns a fresh credential by identity without locking, app reads, or writes', async () => {
    const options = refreshOptions();
    const fresh = Object.freeze({ ...expired, expires_at: '2026-08-27T22:00:00.000Z' });
    options.credentials.readRecord = vi.fn().mockResolvedValue(fresh);
    const acquire = vi.spyOn(options.store, 'acquireRefreshLock');

    expect(await new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject'))).toBe(fresh);
    expect(acquire).not.toHaveBeenCalled();
    expect(options.applications.application).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(options.vault.replace).not.toHaveBeenCalled();
  });

  it('rejects missing refresh tokens before acquiring the lease', async () => {
    const options = refreshOptions();
    options.credentials.readRecord = vi.fn().mockResolvedValue({ ...expired, refresh_token: '' });
    const acquire = vi.spyOn(options.store, 'acquireRefreshLock');

    await expect(new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject')))
      .rejects.toThrow('expired and must be reconnected');
    expect(acquire).not.toHaveBeenCalled();
    expect(options.applications.application).not.toHaveBeenCalled();
  });

  it('preserves per-token clock reads while refreshing primary and delegated tokens sequentially', async () => {
    const events: string[] = [];
    const options = refreshOptions();
    options.registry = secondaryRegistry();
    options.credentials.readRecord = async () => {
      events.push('read');
      return { ...expired, user_access_token: 'old-user', user_refresh_token: 'user-refresh', user_expires_at: expired.expires_at };
    };
    options.clock = { now: () => { events.push('clock'); return fixedClock.now(); } };
    options.randomId = () => { events.push('random'); return 'lease'; };
    options.store.acquireRefreshLock = async () => { events.push('acquire'); return true; };
    options.applications.application = async () => { events.push('app'); return { clientId: 'id', clientSecret: 'secret' }; };
    options.fetch = vi.fn(async (_url, init) => {
      events.push(`fetch:${new URLSearchParams(String(init?.body)).get('refresh_token')}`);
      return new Response(JSON.stringify({ access_token: 'replacement', expires_in: 3600 }));
    });
    options.vault.replace = async () => { events.push('replace'); };
    options.store.releaseRefreshLock = async () => { events.push('release'); };

    await new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject'));
    expect(events).toEqual([
      'read', 'clock', 'clock', 'clock', 'random', 'clock', 'acquire', 'app',
      'clock', 'clock', 'fetch:old-refresh', 'clock', 'clock', 'fetch:user-refresh', 'replace', 'release',
    ]);
  });

  it('does not write a partial replacement when the delegated refresh fails', async () => {
    const options = refreshOptions();
    options.registry = secondaryRegistry();
    const original = Object.freeze({ ...expired, user_refresh_token: 'old-user-refresh', user_expires_at: expired.expires_at });
    options.credentials.readRecord = vi.fn().mockResolvedValue(original);
    options.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-primary', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rejected' }), { status: 400 }));
    const release = vi.spyOn(options.store, 'releaseRefreshLock');

    await expect(new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject')))
      .rejects.toThrow('rejected the OAuth token exchange');
    expect(original.access_token).toBe('old-access');
    expect(options.vault.replace).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('api:owner-1', 'connection-1', 'lock-1');
  });

  it('releases an acquired lease when application loading or vault replacement fails', async () => {
    for (const failingStep of ['app', 'vault']) {
      const options = refreshOptions();
      const cause = new Error(`${failingStep} unavailable`);
      if (failingStep === 'app') options.applications.application = vi.fn().mockRejectedValue(cause);
      else options.vault.replace = vi.fn().mockRejectedValue(cause);
      const release = vi.spyOn(options.store, 'releaseRefreshLock');

      await expect(new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject'))).rejects.toBe(cause);
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it('exhausts the contested-lease backoff without refreshing or releasing another worker’s lease', async () => {
    const options = refreshOptions();
    options.store.acquireRefreshLock = vi.fn().mockResolvedValue(false);
    const release = vi.spyOn(options.store, 'releaseRefreshLock');

    await expect(new OAuthRefreshingCredentialBroker(options).readRecord('secret-ref', connection('subject')))
      .rejects.toBeInstanceOf(IntegrationProviderUnavailableError);
    expect(options.sleep).toHaveBeenCalledTimes(10);
    expect(vi.mocked(options.sleep!).mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]);
    expect(options.credentials.readRecord).toHaveBeenCalledTimes(11);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('OAuth application secret boundary', () => {
  it('preserves reader failures and normalizes syntax failures without exposing secret contents', async () => {
    const cause = new Error('reader unavailable');
    const get = vi.fn()
      .mockRejectedValueOnce(cause)
      .mockRejectedValueOnce(new SyntaxError('private content'))
      .mockResolvedValueOnce('{private-content');
    const applications = new SecretOAuthApplicationRegistry({ get }, { slack: 'secret-ref' });

    await expect(applications.application('slack')).rejects.toBe(cause);
    await expect(applications.application('slack')).rejects.toThrow('OAuth application secret for slack is invalid');
    await expect(applications.application('slack')).rejects.toThrow('OAuth application secret for slack is invalid');
  });
});
