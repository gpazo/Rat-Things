import { describe, expect, it } from 'vitest';
import { threadForSource } from '../../src/ingress/thread.js';
import { normalizedWork } from '../../src/ingress/providers/shared.js';

describe('provider thread identities', () => {
  it('keys repository threads by repository and PR or MR number across deliveries', () => {
    const github = { kind: 'github' as const, repository: 'acme/app', issueNumber: 7, event: 'pull_request', deliveryId: 'one' };
    expect(threadForSource(github)).toBe('["github","acme/app",7]');
    expect(threadForSource({ ...github, deliveryId: 'two', event: 'issue_comment' })).toBe(threadForSource(github));
    expect(threadForSource({ kind: 'gitlab', projectId: '123', mergeRequestIid: 7, event: 'merge_request' })).toBe('["gitlab","123",7]');
  });
  it('keeps sender isolation by default and shares only an explicitly selected thread scope', () => {
    const slack = { kind: 'slack' as const, teamId: 'team', channelId: 'channel', threadTs: '1', eventId: 'one', userId: 'first' };
    expect(threadForSource(slack)).not.toBe(threadForSource({ ...slack, userId: 'second' }));
    expect(threadForSource(slack, 'thread')).toBe(threadForSource({ ...slack, userId: 'second' }, 'thread'));
    expect(threadForSource(slack, 'thread')).not.toBe(threadForSource({ ...slack, teamId: 'other' }, 'thread'));
    const teams = { kind: 'teams' as const, tenantId: 'tenant', conversationId: 'thread', activityId: 'one', senderId: 'first' };
    expect(threadForSource(teams)).not.toBe(threadForSource({ ...teams, senderId: 'second' }));
    expect(threadForSource(teams, 'thread')).toBe(threadForSource({ ...teams, senderId: 'second' }, 'thread'));
  });
  it('retains provider actor attribution and normalized head-change intent', () => {
    const work = normalizedWork({ ownerId: 'provider', mentioned: true, idempotencyKey: 'one', repositoryHeadChanged: true, actor: { kind: 'human', id: 'github:123' }, request: { prompt: 'Review', source: { kind: 'github', deliveryId: 'one', repository: 'acme/app', issueNumber: 7, event: 'pull_request' } } }, 'one');
    expect(work.threadId).toBe('["github","acme/app",7]');
    expect(work.input).toMatchObject({ repositoryHeadChanged: true, actor: { kind: 'human', id: 'github:123' } });
  });
});
