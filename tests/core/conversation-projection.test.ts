import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  projectPublicConversation,
  projectPublicConversationDetail,
} from '../../src/core/conversation-projection.js';
import type {
  ConversationCheckpoint,
  ConversationRecord,
} from '../../src/domain/conversations.js';

describe('public conversation projection', () => {
  it('keeps product state and transcript while stripping authority and execution handles', () => {
    const record = conversation();
    const checkpoint: ConversationCheckpoint = {
      version: '1',
      messages: [
        { role: 'user', content: 'Ship it', messageId: 'message-1', receivedAt: record.createdAt },
        { role: 'assistant', content: 'Done.' },
        { role: 'tool', content: 'internal tool detail' },
      ],
      metadata: { compactedMessages: 4, privateMarker: 'omit-me' },
    };
    const detail = projectPublicConversationDetail(record, checkpoint, {
      messages: [
        {
          role: 'user',
          content: 'Ship it',
          messageId: 'message-1',
          receivedAt: record.createdAt,
          attachmentIds: ['b'.repeat(64)],
          replyToMessageId: 'assistant-prior',
          reactions: [{ emoji: '👍', count: 1, reacted: true }],
        },
        { role: 'assistant', content: 'Done.' },
      ],
      nextToken: 'older-page',
    }, {
      version: '1',
      itemType: 'turn',
      conversationId: record.conversationId,
      turnId: 'turn-private',
      state: 'running',
      slice: 0,
      startedAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      runId: 'run-1',
      checkpoint: artifact('turn-checkpoint.json'),
    });

    expect(detail).toEqual({
      conversationId: createHash('sha256').update(record.conversationId).digest('hex'),
      title: 'Release review',
      threadKey: 'release',
      status: 'running',
      pendingCount: 1,
      sourceKind: 'api',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pinned: false,
      hidden: false,
      unread: true,
      lastMessagePreview: 'Done.',
      latestProgress: record.latestProgress,
      session: {
        backend: 'microvm',
        state: 'suspended',
        updatedAt: record.updatedAt,
        expiresAt: '2026-08-24T18:00:00.000Z',
      },
      activeRunId: 'run-1',
      transcript: {
        messages: [
          {
            role: 'user',
            content: 'Ship it',
            messageId: 'message-1',
            receivedAt: record.createdAt,
            attachments: [{ id: 'b'.repeat(64) }],
            replyToMessageId: 'assistant-prior',
            reactions: [{ emoji: '👍', count: 1, reacted: true }],
          },
          { role: 'assistant', content: 'Done.' },
        ],
        compactedMessages: 4,
        nextToken: 'older-page',
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(/owner-1|microvm-private|thread-private|bucket|privateMarker/);
  });

  it('does not expose a provider conversation key as a reply target', () => {
    const record = conversation({
      conversationId: 'slack:tenant:user:channel:thread',
      source: {
        kind: 'slack',
        teamId: 'tenant',
        channelId: 'channel',
        threadTs: 'thread',
        eventId: 'event',
        userId: 'user',
      },
    });
    expect(projectPublicConversation(record)).not.toHaveProperty('threadKey');
  });
});

function conversation(patch: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: '1',
    itemType: 'conversation',
    conversationId: 'api:0123456789abcdef0123456789abcdef:release',
    ownerId: 'api:owner-1',
    capabilityOwnerId: 'api:capability-owner',
    status: 'running',
    pendingCount: 1,
    title: 'Release review',
    lastMessagePreview: 'Done.',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:01:00.000Z',
    expiresAt: 1_800_000_000,
    source: { kind: 'api' },
    destination: { kind: 'none' },
    actor: { kind: 'human', id: 'api:owner-1', provider: 'api' },
    credentialSubject: { kind: 'actor', id: 'api:owner-1' },
    activeTurnId: 'turn-private',
    context: artifact('context.json'),
    artifacts: artifact('catalog.json'),
    session: {
      backend: 'microvm',
      id: 'microvm-private',
      state: 'suspended',
      updatedAt: '2026-08-24T10:01:00.000Z',
      expiresAt: '2026-08-24T18:00:00.000Z',
      agentThreadId: 'thread-private',
    },
    latestProgress: {
      eventId: 'progress-1',
      text: 'Checking deployment',
      reportedAt: '2026-08-24T10:00:30.000Z',
    },
    ...patch,
  };
}

function artifact(key: string) {
  return { bucket: 'private-bucket', key, sha256: 'a'.repeat(64) };
}
