import { afterEach, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { GitHubDeliveryAdapter } from '../../src/delivery/providers/github.js';
import { GitLabDeliveryAdapter } from '../../src/delivery/providers/gitlab.js';
import { SlackDeliveryAdapter } from '../../src/delivery/providers/slack.js';
import { TeamsDeliveryAdapter } from '../../src/delivery/providers/teams.js';
import type { DeliveryRequest } from '../../src/delivery/types.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['github', 'GITHUB_NOTIFY_TOKEN_SECRET_ARN'],
  ['gitlab', 'GITLAB_NOTIFY_TOKEN_SECRET_ARN'],
  ['slack', 'SLACK_BOT_TOKEN_SECRET_ARN'],
  ['workflow', 'TEAMS_WORKFLOW_URL_SECRET_ARN'],
  ['threaded-gateway', 'TEAMS_REPLY_GATEWAY_URL_SECRET_ARN'],
] as const)('explains missing %s configuration before reading secrets or sending', async (provider, setting) => {
  const get = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const credentials = new CredentialBroker({ get });
  const adapter = provider === 'github'
    ? new GitHubDeliveryAdapter(credentials, { apiBaseUrl: 'https://api.github.com' })
    : provider === 'gitlab'
      ? new GitLabDeliveryAdapter(credentials, { apiBaseUrl: 'https://gitlab.com/api/v4' })
      : provider === 'slack'
        ? new SlackDeliveryAdapter(credentials, {})
        : new TeamsDeliveryAdapter(credentials, { mode: provider, routes: {} });
  const source = provider === 'github'
    ? { kind: 'github', repository: 'acme/project', issueNumber: 7 }
    : provider === 'gitlab'
      ? { kind: 'gitlab', projectId: 1, mergeRequestIid: 7 }
      : provider === 'slack'
        ? { kind: 'slack', channelId: 'C123' }
        : { kind: 'teams', conversationId: 'conversation-1', activityId: 'activity-1' };
  const input = {
    request: { source },
    context: { source, destination: { kind: 'source' } },
    run: { runId: 'run-1' },
    body: 'result',
  } as DeliveryRequest;

  await expect(adapter.deliver(input)).rejects.toMatchObject({
    name: 'KnownNotDeliveredError',
    retryable: false,
    message: `Configure ${setting} before delivering results.`,
  });
  expect(get).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
