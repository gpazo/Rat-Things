import { describe, expect, it, vi } from 'vitest';
import { createLinearIntegrationPlugin } from '../../src/plugins/integrations/linear.js';
import { createSlackIntegrationPlugin } from '../../src/plugins/integrations/slack.js';
import { createStripeIntegrationPlugin } from '../../src/plugins/integrations/stripe.js';
import { createFixtureCrmIntegrationPlugin } from '../../src/plugins/integrations/fixture-crm.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';

describe('trusted HTTP integration plugins', () => {
  it('keeps credentials in headers and sends only to the fixed Slack API origin', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const plugin = createSlackIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.execute('slack.messages.search', { query: 'invoice' }, {
      connection: connection(),
      credential: { access_token: 'xoxb-private-token', user_access_token: 'xoxp-private-user-token' },
    })).resolves.toMatchObject({ ok: true });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://slack.com/api/search.messages?query=invoice');
    expect(url.toString()).not.toContain('xoxp-private-user-token');
    expect(init.headers).toMatchObject({ authorization: 'Bearer xoxp-private-user-token' });
    expect(init.redirect).toBe('error');
  });

  it('calls Slack api.test without attaching a credential to its no-scope operation', async () => {
    const marker = 'rat-things-provider-proof';
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      args: { marker },
    }), { status: 200 }));
    const plugin = createSlackIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.execute('slack.api.test', { marker }, {
      connection: connection(),
      credential: { token: 'must-not-leave-the-broker' },
    })).resolves.toMatchObject({ ok: true, args: { marker } });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://slack.com/api/api.test');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('authorization');
    expect(init.body).toBe(`marker=${marker}`);
  });

  it('treats Slack HTTP-200 error envelopes as failed operations', async () => {
    const plugin = createSlackIntegrationPlugin({
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), {
        status: 200,
      })) as typeof fetch,
    });

    await expect(plugin.execute('slack.messages.search', { query: 'invoice' }, {
      connection: connection(),
      credential: { user_access_token: 'xoxp-private-user-token' },
    })).rejects.toThrow('Slack returned an API error: missing_scope');
  });

  it('verifies Slack credentials and derives provider-owned account identity', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      team: 'Acme',
      user: 'Rat',
      team_id: 'T123',
      user_id: 'U123',
    }), { status: 200 }));
    const plugin = createSlackIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.verifyCredential('oauth2', {
      access_token: 'xoxb-private-token',
      scope: 'app_mentions:read,chat:write',
      user_scope: 'search:read',
    }))
      .resolves.toEqual({
        label: 'Acme — Rat',
        externalTenantId: 'T123',
        externalSubjectId: 'U123',
        authorization: {
          scheme: 'oauth2',
          access: 'full',
          scopeModel: 'granular',
          scopes: ['app_mentions:read', 'chat:write', 'search:read'],
        },
      });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://slack.com/api/auth.test');
    expect(init.headers).toMatchObject({ authorization: 'Bearer xoxb-private-token' });
  });

  it('verifies Stripe keys against the current account endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: 'acct_123',
      business_profile: { name: 'Acme Billing' },
    }), { status: 200 }));
    const plugin = createStripeIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.verifyCredential('api-key', { api_key: 'sk_test_private' }))
      .resolves.toMatchObject({
        label: 'Acme Billing',
        externalTenantId: 'acct_123',
        authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown' },
      });
    const [url] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.stripe.com/v1/account');
  });

  it('verifies a Linear OAuth connection and derives its workspace identity', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: {
        viewer: { id: 'user-123', name: 'Rat Things' },
        organization: { id: 'workspace-123', name: 'Acme' },
      },
    }), { status: 200 }));
    const plugin = createLinearIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.verifyCredential('oauth2', {
      access_token: 'linear-private-token',
      scope: 'read write',
    })).resolves.toEqual({
      label: 'Acme — Rat Things',
      externalTenantId: 'workspace-123',
      externalSubjectId: 'user-123',
      authorization: {
        scheme: 'oauth2', access: 'full', scopeModel: 'granular', scopes: ['read', 'write'],
      },
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.linear.app/graphql');
    expect(init.headers).toMatchObject({ authorization: 'Bearer linear-private-token' });
    expect(String(init.body)).not.toContain('linear-private-token');
  });

  it('binds Linear issue operations to fixed GraphQL documents and variables', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { issueCreate: { success: true, issue: { id: 'issue-123', identifier: 'ENG-123' } } },
    }), { status: 200 }));
    const plugin = createLinearIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.execute('linear.issues.create', {
      teamId: 'team-123',
      title: 'Renewal security follow-up',
      description: 'Context from the approved Slack thread.',
    }, {
      connection: { ...connection(), pluginId: 'linear' },
      credential: { api_key: 'lin_api_private' },
    })).resolves.toMatchObject({ data: { issueCreate: { success: true } } });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    expect(url.toString()).toBe('https://api.linear.app/graphql');
    expect(init.headers).toMatchObject({ authorization: 'lin_api_private' });
    expect(body.query).toContain('mutation RatThingsCreateLinearIssue');
    expect(body.variables).toEqual({
      input: {
        teamId: 'team-123',
        title: 'Renewal security follow-up',
        description: 'Context from the approved Slack thread.',
      },
    });
    expect(String(init.body)).not.toContain('lin_api_private');
  });

  it('fails closed on Linear GraphQL errors and empty issue updates', async () => {
    const plugin = createLinearIntegrationPlugin({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        errors: [{ message: 'not authorized', extensions: { code: 'AUTHENTICATION_ERROR' } }],
      }), { status: 200 })) as typeof fetch,
    });
    const context = {
      connection: { ...connection(), pluginId: 'linear' },
      credential: { access_token: 'linear-private-token' },
    };

    await expect(plugin.execute('linear.issues.search', { query: 'renewal' }, context))
      .rejects.toThrow('Linear returned a GraphQL error: AUTHENTICATION_ERROR');
    await expect(plugin.execute('linear.issues.update', { issueId: 'ENG-123' }, context))
      .rejects.toThrow('requires at least one change');
  });

  it('uses a verified fixture account for read and write operations', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/fixture/me') {
        return new Response(JSON.stringify({
          ok: true,
          label: 'Beta Support',
          tenant_id: 'fixture-beta',
          subject_id: 'fixture-service-beta',
          access: 'full',
          scopes: ['records:read', 'records:write'],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, account: 'beta' }), { status: 200 });
    });
    const plugin = createFixtureCrmIntegrationPlugin(
      'http://127.0.0.1:8080/fixture/',
      { fetch: fetcher },
    );

    await expect(plugin.verifyCredential('api-key', { api_key: 'beta-local' }))
      .resolves.toMatchObject({ label: 'Beta Support', externalTenantId: 'fixture-beta' });
    await expect(plugin.execute('fixture-crm.records.create', { name: 'Customer' }, {
      connection: { ...connection(), pluginId: 'fixture-crm' },
      credential: { api_key: 'beta-local' },
    })).resolves.toMatchObject({ ok: true, account: 'beta' });
  });

  it('classifies provider throttling and failures as retryable unavailability', async () => {
    const plugin = createFixtureCrmIntegrationPlugin(
      'http://127.0.0.1:8080/fixture/',
      { fetch: vi.fn(async () => new Response('', { status: 503 })) as typeof fetch },
    );

    await expect(plugin.verifyCredential('api-key', { api_key: 'temporary' }))
      .rejects.toBeInstanceOf(IntegrationProviderUnavailableError);
  });
});

function connection() {
  return {
    version: '1' as const,
    connectionId: 'slack-1',
    ownerId: 'owner-1',
    pluginId: 'slack',
    alias: 'slack-shop',
    label: 'Slack Shop',
    authorization: {
      scheme: 'api-key' as const,
      access: 'full' as const,
      scopeModel: 'coarse' as const,
      scopes: [],
    },
    status: 'active' as const,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}
