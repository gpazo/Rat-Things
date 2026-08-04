import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../../src/conversation/service.js';
import {
  ConversationLeaseError,
  type ConversationStore,
} from '../../src/conversation/types.js';
import type { ArtifactStore, Clock } from '../../src/core/ports.js';
import type {
  ConversationMessageRecord,
  ConversationRecord,
  ConversationTurnRecord,
} from '../../src/domain/conversations.js';

const fixedNow = new Date('2026-08-03T12:00:00.000Z');
const clock: Clock = { now: () => fixedNow };
const lease = {
  token: 'lease-1',
  acquiredAt: fixedNow.toISOString(),
  checkedInAt: fixedNow.toISOString(),
  expiresAt: '2026-08-03T12:01:30.000Z',
};

const source = {
  kind: 'teams' as const,
  tenantId: 'tenant-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  conversationId: 'conversation-1',
  activityId: 'activity-1',
  senderId: 'user-1',
};

const actor = { kind: 'human' as const, id: 'teams:tenant-1:user-1', provider: 'teams' as const };
const credentialSubject = { kind: 'runtime' as const, id: 'runtime:teams' };

function conversation(patch: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: '1',
    itemType: 'conversation',
    conversationId: 'conversation-1',
    ownerId: 'teams:tenant-1:user-1',
    status: 'running',
    pendingCount: 1,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    expiresAt: 1_800_000_000,
    source,
    destination: { kind: 'source' },
    actor,
    credentialSubject,
    lease,
    ...patch,
  };
}

function turn(patch: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    version: '1',
    itemType: 'turn',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    state: 'running',
    slice: 0,
    startedAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    expiresAt: 1_800_000_000,
    ...patch,
  };
}

function harness(ids = ['id-1', 'id-2', 'id-3']) {
  const store = {
    getConversation: vi.fn(),
    appendMessage: vi.fn(),
    listPending: vi.fn(),
    acquireLease: vi.fn(),
    checkIn: vi.fn(),
    beginTurn: vi.fn(),
    attachRun: vi.fn(),
    scheduleRun: vi.fn(),
    resumeTurn: vi.fn(),
    checkpointTurn: vi.fn(),
    reportProgress: vi.fn(),
    consumeMessages: vi.fn(),
    completeTurn: vi.fn(),
    failTurn: vi.fn(),
    getTurn: vi.fn(),
    listEvents: vi.fn(),
  } as unknown as ConversationStore;
  const writes: Array<{ key: string; value: string }> = [];
  const artifacts: ArtifactStore = {
    putJson: vi.fn(),
    getJson: vi.fn(),
    putBytes: vi.fn(async (key, value) => {
      const encoded = Buffer.from(value).toString('utf8');
      writes.push({ key, value: encoded });
      return {
        bucket: 'artifacts',
        key,
        sha256: createHash('sha256').update(value).digest('hex'),
      };
    }),
  };
  let nextId = 0;
  const service = new ConversationService({
    store,
    artifacts,
    clock,
    ids: { random: () => ids[nextId++] ?? `generated-${nextId}` },
    retentionSeconds: 600,
    leaseSeconds: 90,
  });
  return { service, store, writes };
}

beforeEach(() => vi.restoreAllMocks());

describe('conversation service', () => {
  it('stores content-addressed message bodies and a bounded DynamoDB projection', async () => {
    const { service, store, writes } = harness();
    vi.mocked(store.appendMessage).mockImplementation(async (input) => ({
      status: 'appended',
      conversation: input.conversation,
      message: input.message,
    }));

    const result = await service.appendMessage({
      conversationId: 'conversation-1',
      ownerId: 'teams:tenant-1:user-1',
      messageId: 'activity-1',
      delivery: 'interrupt',
      content: { text: 'Investigate the deployment.', metadata: { second: 2, first: 1 } },
      source,
      destination: { kind: 'source' },
      actor,
      credentialSubject,
      executionPolicy: { driver: 'codex', sandbox: 'workspace-write', reasoningEffort: 'low' },
    });

    expect(result.status).toBe('appended');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe(
      '{"metadata":{"first":1,"second":2},"text":"Investigate the deployment."}',
    );
    expect(writes[0]?.key).toMatch(
      /^owners\/[a-f0-9]{32}\/conversations\/[a-f0-9]{32}\/messages\/[a-f0-9]{32}-[a-f0-9]{64}\.json$/,
    );
    const persisted = vi.mocked(store.appendMessage).mock.calls[0]?.[0];
    expect(persisted?.conversation).toMatchObject({
      status: 'pending',
      pendingCount: 1,
      ownerId: 'teams:tenant-1:user-1',
      executionPolicy: { driver: 'codex', sandbox: 'workspace-write', reasoningEffort: 'low' },
    });
    expect(persisted?.message).toMatchObject({
      delivery: 'interrupt',
      state: 'pending',
      messageId: 'activity-1',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(persisted?.event).toMatchObject({
      type: 'message_received',
      messageId: 'activity-1',
      payload: persisted?.message.content,
    });
  });

  it('creates a renewable worker lease and preserves interrupt-first mailbox requests', async () => {
    const { service, store } = harness(['lease-1']);
    vi.mocked(store.acquireLease).mockImplementation(async (input) => ({
      status: 'acquired',
      conversation: conversation({ lease: input.lease }),
      lease: input.lease,
    }));
    vi.mocked(store.getConversation).mockResolvedValue(conversation());
    vi.mocked(store.listPending).mockResolvedValue([
      { messageId: 'interrupt-1', delivery: 'interrupt' } as ConversationMessageRecord,
    ]);
    vi.mocked(store.checkIn).mockImplementation(async (input) => conversation({ lease: input.lease }));

    const acquired = await service.acquireLease('conversation-1');
    expect(acquired).toMatchObject({
      status: 'acquired',
      lease: {
        token: 'lease-1',
        expiresAt: '2026-08-03T12:01:30.000Z',
      },
    });
    await expect(service.pending('conversation-1', 'lease-1', {
      delivery: 'interrupt',
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({ messageId: 'interrupt-1', delivery: 'interrupt' }),
    ]);
    await service.checkIn('conversation-1', 'lease-1');
    expect(store.listPending).toHaveBeenCalledWith('conversation-1', {
      delivery: 'interrupt',
      limit: 10,
    });
    expect(store.checkIn).toHaveBeenCalledWith(expect.objectContaining({
      expectedToken: 'lease-1',
      lease: expect.objectContaining({ expiresAt: '2026-08-03T12:01:30.000Z' }),
    }));
  });

  it('persists progress and resumable checkpoints outside the coordination record', async () => {
    const { service, store, writes } = harness(['progress-1', 'checkpoint-event-1']);
    vi.mocked(store.getConversation).mockResolvedValue(conversation({ activeTurnId: 'turn-1' }));
    vi.mocked(store.getTurn).mockResolvedValue(turn());
    vi.mocked(store.reportProgress).mockResolvedValue(conversation({
      activeTurnId: 'turn-1',
      latestProgress: {
        eventId: 'progress-1',
        text: 'Inspecting deployment logs',
        reportedAt: fixedNow.toISOString(),
      },
    }));
    vi.mocked(store.checkpointTurn).mockResolvedValue(turn({
      state: 'awaiting_resume',
      checkpoint: { bucket: 'artifacts', key: 'checkpoint', sha256: 'hash' },
      resumeReason: 'yield',
    }));

    await service.reportProgress({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      leaseToken: 'lease-1',
      text: 'Inspecting deployment logs',
    });
    await service.checkpointTurn({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      leaseToken: 'lease-1',
      reason: 'yield',
      checkpoint: { version: '1', messages: [{ role: 'assistant', content: 'partial' }] },
    });

    expect(writes).toHaveLength(2);
    expect(writes.some(({ key }) => key.includes('/events/'))).toBe(true);
    expect(writes.some(({ key }) => key.includes('/turns/') && key.includes('slice-0000'))).toBe(true);
    expect(store.reportProgress).toHaveBeenCalledWith(expect.objectContaining({
      progress: expect.objectContaining({ text: 'Inspecting deployment logs' }),
      leaseToken: 'lease-1',
    }));
    expect(store.checkpointTurn).toHaveBeenCalledWith(expect.objectContaining({
      resumeReason: 'yield',
      checkpoint: expect.objectContaining({ bucket: 'artifacts' }),
    }));
  });

  it('rejects work performed without the current durable lease', async () => {
    const { service, store } = harness();
    const unleased = conversation();
    delete unleased.lease;
    vi.mocked(store.getConversation).mockResolvedValue(unleased);

    await expect(service.pending('conversation-1', 'stale-lease'))
      .rejects.toBeInstanceOf(ConversationLeaseError);
    expect(store.listPending).not.toHaveBeenCalled();
  });
});
