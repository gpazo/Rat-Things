import { describe, expect, it } from 'vitest';

import {
  normalizeGitHubWebhook,
  normalizeGitLabWebhook,
  normalizeSlackEvent,
  normalizeTeamsWebhook,
} from '../../src/channels/normalize.js';
import { AGENT_RESULT_MARKER } from '../../src/channels/result-marker.js';

const credentialSecretArn =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:provider/runtime-token-AbCd12';

describe('GitHub webhook normalization', () => {
  it('normalizes a pull-request review into a stable run request', () => {
    const normalized = normalizeGitHubWebhook(
      'pull_request',
      'delivery-123',
      {
        action: 'synchronize',
        number: 17,
        repository: {
          full_name: 'acme/widgets',
          clone_url: 'https://github.com/acme/widgets.git',
        },
        installation: { id: 42 },
        pull_request: {
          title: 'Fix widget races',
          body: 'Protect the shared cache.',
          user: { login: 'octocat' },
          head: { sha: 'abc123def456' },
          base: { ref: 'main' },
        },
      },
      credentialSecretArn,
    );

    expect(normalized).toEqual({
      ownerId: 'github:42',
      idempotencyKey: 'github:delivery-123',
      request: {
        version: '1',
        prompt: expect.stringContaining('Review GitHub pull request #17 in acme/widgets.'),
        repository: {
          provider: 'github',
          url: 'https://github.com/acme/widgets.git',
          ref: 'abc123def456',
          baseRef: 'main',
          installationId: '42',
          credentialSecretArn,
        },
        agent: { sandbox: 'read-only' },
        source: {
          kind: 'github',
          deliveryId: 'delivery-123',
          event: 'pull_request',
          repository: 'acme/widgets',
          issueNumber: 17,
          installationId: '42',
        },
        metadata: { action: 'synchronize' },
      },
    });
    expect(normalized?.request.prompt).toContain('Title: Fix widget races');
    expect(normalized?.request.prompt).toContain('Author: octocat');
    expect(normalized?.request.prompt).toContain('Description:\nProtect the shared cache.');
    expect(normalized?.request.prompt).toContain('Do not modify the repository.');
  });

  it('normalizes pull-request comments and falls back to repository owner identity', () => {
    const normalized = normalizeGitHubWebhook(
      'issue_comment',
      'delivery-comment',
      {
        action: 'created',
        repository: {
          full_name: 'acme/widgets',
          clone_url: 'https://github.com/acme/widgets.git',
        },
        issue: { number: 9, pull_request: { url: 'https://api.github.test/pulls/9' } },
        comment: { body: '@agent explain the race' },
      },
      undefined,
      '@agent',
    );

    expect(normalized).toMatchObject({
      ownerId: 'github:acme',
      idempotencyKey: 'github:delivery-comment',
      request: {
        prompt: expect.stringContaining('@agent explain the race'),
        repository: { provider: 'github', url: 'https://github.com/acme/widgets.git' },
        source: {
          kind: 'github',
          event: 'issue_comment',
          issueNumber: 9,
          repository: 'acme/widgets',
        },
      },
    });
  });

  it.each([
    ['unsupported PR action', 'pull_request', { action: 'closed' }],
    ['non-created comment', 'issue_comment', { action: 'edited' }],
    ['unsupported event', 'push', {}],
  ])('ignores %s', (_label, event, partial) => {
    expect(
      normalizeGitHubWebhook(event, 'delivery', {
        ...partial,
        number: 1,
        repository: { full_name: 'acme/widgets', clone_url: 'https://github.com/acme/widgets.git' },
        pull_request: { head: { sha: 'abc123' } },
        issue: { number: 1, pull_request: {} },
        comment: { body: 'hello' },
      }),
    ).toBeUndefined();
  });

  it('ignores malformed payloads without throwing', () => {
    expect(normalizeGitHubWebhook('pull_request', 'delivery', null)).toBeUndefined();
    expect(normalizeGitHubWebhook('pull_request', 'delivery', { repository: {} })).toBeUndefined();
  });

  it('requires a trigger and ignores agent-authored result comments', () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'acme/widgets', clone_url: 'https://github.com/acme/widgets.git' },
      issue: { number: 9, pull_request: {} },
      comment: { body: '@agent explain this' },
    };
    expect(normalizeGitHubWebhook('issue_comment', 'missing-trigger', payload)).toBeUndefined();
    expect(normalizeGitHubWebhook('issue_comment', 'own-result', {
      ...payload,
      comment: { body: `${AGENT_RESULT_MARKER}\n@agent completed` },
    }, undefined, '@agent')).toBeUndefined();
    expect(normalizeGitHubWebhook('issue_comment', 'bot-result', {
      ...payload,
      comment: { body: '@agent completed', user: { type: 'Bot' } },
    }, undefined, '@agent')).toBeUndefined();
  });
});

describe('GitLab webhook normalization', () => {
  it('normalizes a merge request and derives a clone URL from the project URL', () => {
    const normalized = normalizeGitLabWebhook(
      'Merge Request Hook',
      'gitlab-delivery-1',
      {
        object_kind: 'merge_request',
        project: {
          id: 81,
          path_with_namespace: 'acme/widgets',
          web_url: 'https://gitlab.com/acme/widgets/',
        },
        object_attributes: {
          action: 'open',
          iid: 23,
          title: 'Validate queue claims',
          description: 'Use a conditional transition.',
          target_branch: 'main',
          last_commit: { id: 'fedcba987654' },
        },
      },
      credentialSecretArn,
    );

    expect(normalized).toEqual({
      ownerId: 'gitlab:81',
      idempotencyKey: 'gitlab:gitlab-delivery-1',
      request: {
        version: '1',
        prompt: expect.stringContaining('Review GitLab merge request !23 in acme/widgets.'),
        repository: {
          provider: 'gitlab',
          url: 'https://gitlab.com/acme/widgets.git',
          ref: 'fedcba987654',
          baseRef: 'main',
          credentialSecretArn,
        },
        agent: { sandbox: 'read-only' },
        source: {
          kind: 'gitlab',
          event: 'Merge Request Hook',
          projectId: '81',
          mergeRequestIid: 23,
        },
        metadata: { action: 'open' },
      },
    });
    expect(normalized?.request.prompt).toContain('Description:\nUse a conditional transition.');
  });

  it('normalizes a merge-request note', () => {
    const normalized = normalizeGitLabWebhook(
      'Note Hook',
      'note-delivery',
      {
        object_kind: 'note',
        project: {
          id: '81',
          path_with_namespace: 'acme/widgets',
          git_http_url: 'https://gitlab.com/acme/widgets.git',
        },
        object_attributes: { note: '@agent summarize the impact' },
        merge_request: { iid: 23, last_commit: { id: 'abc123' } },
      },
      undefined,
      '@agent',
    );

    expect(normalized).toMatchObject({
      ownerId: 'gitlab:81',
      idempotencyKey: 'gitlab:note-delivery',
      request: {
        prompt: expect.stringContaining('@agent summarize the impact'),
        repository: { ref: 'abc123' },
        source: { kind: 'gitlab', mergeRequestIid: 23 },
      },
    });
  });

  it('ignores unsupported and incomplete events', () => {
    const base = {
      project: {
        id: 81,
        path_with_namespace: 'acme/widgets',
        git_http_url: 'https://gitlab.com/acme/widgets.git',
      },
    };
    expect(
      normalizeGitLabWebhook('Merge Request Hook', 'delivery', {
        ...base,
        object_kind: 'merge_request',
        object_attributes: { action: 'close', iid: 1, last_commit: { id: 'abc' } },
      }),
    ).toBeUndefined();
    expect(normalizeGitLabWebhook('Push Hook', 'delivery', { ...base, object_kind: 'push' })).toBeUndefined();
    expect(normalizeGitLabWebhook('Note Hook', 'delivery', { ...base, object_kind: 'note' })).toBeUndefined();
  });

  it('requires a trigger and ignores agent-authored GitLab notes', () => {
    const payload = {
      object_kind: 'note',
      project: {
        id: 81,
        path_with_namespace: 'acme/widgets',
        git_http_url: 'https://gitlab.com/acme/widgets.git',
      },
      object_attributes: { note: '@agent summarize' },
      merge_request: { iid: 23 },
    };
    expect(normalizeGitLabWebhook('Note Hook', 'missing-trigger', payload)).toBeUndefined();
    expect(normalizeGitLabWebhook('Note Hook', 'own-result', {
      ...payload,
      object_attributes: { note: `${AGENT_RESULT_MARKER}\n@agent completed` },
    }, undefined, '@agent')).toBeUndefined();
    expect(normalizeGitLabWebhook('Note Hook', 'bot-result', {
      ...payload,
      user: { bot: true },
    }, undefined, '@agent')).toBeUndefined();
  });

  it('checks out the GitLab merge-request ref when a note omits last_commit', () => {
    const normalized = normalizeGitLabWebhook('Note Hook', 'note-without-sha', {
      object_kind: 'note',
      project: {
        id: 81,
        path_with_namespace: 'acme/widgets',
        git_http_url: 'https://gitlab.com/acme/widgets.git',
      },
      object_attributes: { note: '@agent inspect this change' },
      merge_request: { iid: 23 },
    }, undefined, '@agent');

    expect(normalized?.request.repository?.ref).toBe('refs/merge-requests/23/head');
  });
});

describe('chat webhook normalization', () => {
  it('normalizes Teams activities and removes mention markup', () => {
    const normalized = normalizeTeamsWebhook({
      id: 'activity-1',
      text: '<at>Runtime Agent</at>   inspect <b>this</b> change',
      conversation: { id: 'conversation-1' },
      from: { id: 'user-1' },
      channelData: {
        tenant: { id: 'tenant-1' },
        team: { id: 'team-1' },
        channel: { id: 'channel-1' },
      },
    });

    expect(normalized).toEqual({
      ownerId: 'teams:tenant-1:user-1',
      idempotencyKey: 'teams:activity-1',
      request: {
        version: '1',
        prompt: 'inspect this change',
        agent: { sandbox: 'read-only' },
        source: {
          kind: 'teams',
          tenantId: 'tenant-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          conversationId: 'conversation-1',
          activityId: 'activity-1',
          senderId: 'user-1',
        },
      },
    });
  });

  it('normalizes Slack app mentions and preserves thread routing', () => {
    const normalized = normalizeSlackEvent({
      event_id: 'event-1',
      team_id: 'workspace-1',
      event: {
        type: 'app_mention',
        channel: 'channel-1',
        user: 'user-1',
        thread_ts: '1000.2000',
        ts: '1000.3000',
        text: '<@U123ABC>   inspect the queue',
      },
    });

    expect(normalized).toEqual({
      ownerId: 'slack:workspace-1:user-1',
      idempotencyKey: 'slack:event-1',
      request: {
        version: '1',
        prompt: 'inspect the queue',
        agent: { sandbox: 'read-only' },
        source: {
          kind: 'slack',
          teamId: 'workspace-1',
          channelId: 'channel-1',
          threadTs: '1000.2000',
          eventId: 'event-1',
          userId: 'user-1',
        },
      },
    });
  });

  it('ignores empty Teams activities and non-mention Slack events', () => {
    expect(
      normalizeTeamsWebhook({ id: 'activity', text: '<at>Runtime Agent</at>', conversation: { id: 'c' } }),
    ).toBeUndefined();
    expect(
      normalizeSlackEvent({
        event_id: 'event',
        event: { type: 'message', channel: 'channel', text: 'hello' },
      }),
    ).toBeUndefined();
    expect(
      normalizeSlackEvent({
        event_id: 'bot-event',
        event: {
          type: 'app_mention',
          subtype: 'bot_message',
          bot_id: 'B123',
          channel: 'channel',
          text: '<@U123> recursive output',
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeTeamsWebhook({
        id: 'activity',
        text: '<at>Runtime Agent</at> inspect this',
        conversation: { id: 'conversation' },
        from: { id: 'user' },
        channelData: {},
      }),
    ).toBeUndefined();
    expect(
      normalizeSlackEvent({
        event_id: 'missing-owner',
        event: { type: 'app_mention', channel: 'channel', text: '<@U123> inspect this' },
      }),
    ).toBeUndefined();
  });
});
