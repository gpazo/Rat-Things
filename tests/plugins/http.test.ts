import { describe, expect, it, vi } from 'vitest';
import { createSlackIntegrationPlugin } from '../../src/plugins/integrations/slack.js';

describe('trusted HTTP integration plugins', () => {
  it('keeps credentials in headers and sends only to the fixed Slack API origin', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const plugin = createSlackIntegrationPlugin({ fetch: fetcher as typeof fetch });

    await expect(plugin.execute('slack.messages.search', { query: 'invoice' }, {
      connection: connection(),
      credential: { token: 'xoxb-private-token' },
    })).resolves.toMatchObject({ ok: true });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://slack.com/api/search.messages?query=invoice');
    expect(url.toString()).not.toContain('xoxb-private-token');
    expect(init.headers).toMatchObject({ authorization: 'Bearer xoxb-private-token' });
    expect(init.redirect).toBe('error');
  });

  it('treats Slack HTTP-200 error envelopes as failed operations', async () => {
    const plugin = createSlackIntegrationPlugin({
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), {
        status: 200,
      })) as typeof fetch,
    });

    await expect(plugin.execute('slack.messages.search', { query: 'invoice' }, {
      connection: connection(),
      credential: { token: 'xoxb-private-token' },
    })).rejects.toThrow('Slack returned an API error');
  });
});

function connection() {
  return {
    version: '1' as const,
    connectionId: 'slack-1',
    ownerId: 'owner-1',
    pluginId: 'slack',
    alias: 'slack-shop',
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
