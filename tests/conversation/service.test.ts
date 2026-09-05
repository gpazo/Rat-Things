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
    getConversationByPublicId: vi.fn(),
    list: vi.fn(),
    updateOrganization: vi.fn(),
    search: vi.fn(),
    appendMessage: vi.fn(),
    updateArtifacts: vi.fn(),
    setReaction: vi.fn(),
    listReactions: vi.fn().mockResolvedValue([]),
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
    listTranscript: vi.fn(),
    listEvents: vi.fn(),
  } as unknown as ConversationStore;
  const writes: Array<{ key: string; value: string }> = [];
  const artifacts: ArtifactStore = {
    putJson: vi.fn(),
    getJson: vi.fn(),
    getBytes: vi.fn(),
    putBytes: vi.fn(async (key, value) => {
      const encoded = Buffer.from(value).toString('utf8');
      writes.push({ key, value: encoded });
      return {
        bucket: 'artifacts',
        key,
        sha256: createHash('sha256').update(value).digest('hex'),
      };
    }),
    putStream: vi.fn(),
    getStream: vi.fn(),
    copy: vi.fn(),
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
  return { service, store, artifacts, writes };
}

beforeEach(() => vi.restoreAllMocks());

describe('conversation service', () => {
  it('lists owner-scoped conversations and reads a bounded public-detail source', async () => {
    const { service, store, artifacts } = harness();
    const record = conversation({
      conversationId: 'api:owner-hash:release',
      ownerId: 'api:owner-1',
      activeTurnId: 'turn-1',
      context: { bucket: 'artifacts', key: 'context.json', sha256: 'a'.repeat(64) },
    });
    vi.mocked(store.list).mockResolvedValue({ items: [record], nextToken: 'next' });
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(store.getTurn).mockResolvedValue(turn({ runId: 'run-1' }));
    vi.mocked(store.listTranscript).mockResolvedValue({ items: [] });
    const checkpoint = {
      version: '1' as const,
      messages: [{ role: 'assistant', content: 'Ready.' }],
    };
    vi.mocked(artifacts.getJson).mockResolvedValue(checkpoint);

    await expect(service.list('api:owner-1', 500, 'cursor')).resolves.toEqual({
      items: [record],
      nextToken: 'next',
    });
    expect(store.list).toHaveBeenCalledWith('api:owner-1', 100, 'cursor', 'visible');
    await expect(service.getPublicDetail('api:owner-1', 'a'.repeat(64))).resolves.toEqual({
      conversation: record,
      checkpoint,
      transcript: { messages: [] },
      activeTurn: expect.objectContaining({ runId: 'run-1' }),
    });
    await expect(service.getPublicDetail('api:another-owner', 'a'.repeat(64))).resolves.toBeUndefined();
  });

  it('reads turn interactions without changing transcript pagination or losing the final message identity', async () => {
    const {service, store, artifacts} = harness();
    const record = conversation({ownerId: 'api:owner-1'});
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(store.listTranscript).mockResolvedValue({items: [{
      version: '1', itemType: 'transcript', conversationId: record.conversationId,
      entryId: 'turn-1', role: 'assistant', contentKind: 'turn',
      content: {bucket: 'artifacts', key: 'turn.json', sha256: 'a'.repeat(64)},
      occurredAt: record.updatedAt, expiresAt: record.expiresAt, messageId: 'assistant-stable',
    }], nextToken: 'earlier'});
    vi.mocked(artifacts.getJson).mockResolvedValue([
      {role: 'assistant', content: 'Which audience?'},
      {role: 'user', content: 'Executives'},
      {role: 'user', content: 'Direction: make it concise'},
      {role: 'assistant', content: 'Stopped by you. Files saved.'},
    ]);
    const detail = await service.getPublicDetail('api:owner-1', 'a'.repeat(64));
    expect(detail?.transcript.nextToken).toBe('earlier');
    expect(detail?.transcript.messages).toEqual([expect.objectContaining({
      messageId: 'assistant-stable', content: 'Stopped by you. Files saved.',
      interactions: [
        {role: 'assistant', content: 'Which audience?'},
        {role: 'user', content: 'Executives'},
        {role: 'user', content: 'Direction: make it concise'},
      ],
    })]);
  });

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
      title: 'Investigate the deployment.',
      lastMessagePreview: 'Investigate the deployment.',
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
    expect(persisted?.transcript).toMatchObject({
      itemType: 'transcript',
      role: 'user',
      contentKind: 'message',
      content: persisted?.message.content,
      messageId: 'activity-1',
    });
    expect(persisted?.search.map((posting) => posting.token)).toEqual([
      'investigate',
      'the',
      'deployment',
    ]);
    expect(persisted?.search[0]).toMatchObject({
      ownerId: 'teams:tenant-1:user-1',
      kind: 'message',
      role: 'user',
      snippet: 'Investigate the deployment.',
    });
  });

  it('materializes uploads and lease-fences their merge into the durable artifact catalog', async () => {
    const { service, store, writes } = harness();
    const bytes = Buffer.from('durable upload marker');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    vi.mocked(store.getConversation).mockResolvedValueOnce(undefined);

    const prepared = await service.prepareAttachments({
      conversationId: 'api:owner:release',
      ownerId: 'api:owner',
      messageId: 'message-upload',
      sourceRunId: 'run-upload',
      uploads: [{ name: 'notes.txt', mediaType: 'text/plain', bytes, sha256 }],
    });

    expect(prepared.files).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^[a-f0-9]{24}$/),
      path: expect.stringMatching(/^uploads\/[a-f0-9]{12}\/notes\.txt$/),
      mediaType: 'text/plain',
      bytes: bytes.byteLength,
      sourceRunId: 'run-upload',
      file: expect.objectContaining({ sha256 }),
    })]);
    expect(prepared.files[0]?.file.key).toBe(
      `owners/${createHash('sha256').update('api:owner').digest('hex').slice(0, 32)}/blobs/sha256/${sha256}`,
    );
    expect(writes.some((write) => write.key.includes('/attachment-manifests/'))).toBe(true);
    expect(JSON.parse(writes.find((write) => write.key.includes('/attachment-manifests/'))!.value))
      .toEqual({ version: '1', files: prepared.files });

    const leased = conversation({
      conversationId: 'api:owner:release',
      ownerId: 'api:owner',
      lease,
    });
    vi.mocked(store.getConversation).mockResolvedValue(leased);
    vi.mocked(store.updateArtifacts).mockImplementation(async (input) => ({
      ...leased,
      artifacts: input.artifacts!,
      updatedAt: input.updatedAt,
    }));
    const attached = await service.attachArtifacts({
      conversationId: leased.conversationId,
      leaseToken: lease.token,
      files: prepared.files,
    });
    expect(attached.artifacts).toEqual(expect.objectContaining({
      bucket: 'artifacts',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(store.updateArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: leased.conversationId,
      expectedToken: lease.token,
    }));
    expect(writes.some((write) => write.key.includes('/artifacts/'))).toBe(true);
  });

  it('updates owner-scoped organization metadata and tokenizes server search', async () => {
    const { service, store } = harness();
    const record = conversation({ ownerId: 'api:owner-1' });
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(store.updateOrganization).mockResolvedValue({
      ...record,
      pinnedAt: fixedNow.toISOString(),
      readAt: fixedNow.toISOString(),
    });
    vi.mocked(store.search).mockResolvedValue([{ conversation: record, matches: [] }]);

    await expect(service.updateOrganization('api:owner-1', 'a'.repeat(64), {
      pinned: true,
      read: true,
    })).resolves.toMatchObject({ pinnedAt: fixedNow.toISOString() });
    expect(store.updateOrganization).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: record.conversationId,
      ownerId: 'api:owner-1',
      pinned: true,
      read: true,
      now: fixedNow.toISOString(),
    }));
    await expect(service.search('api:owner-1', 'Release deployment release', 80))
      .resolves.toHaveLength(1);
    expect(store.search).toHaveBeenCalledWith(
      'api:owner-1',
      ['release', 'deployment'],
      50,
    );
    await expect(service.updateOrganization('api:other', 'a'.repeat(64), { hidden: true }))
      .resolves.toBeUndefined();
  });

  it('hydrates cursor-paged transcript entries without exposing storage coordinates', async () => {
    const { service, store, artifacts } = harness();
    const record = conversation({
      conversationId: 'api:owner-hash:release',
      ownerId: 'api:owner-1',
    });
    const userBody = { text: 'Review this.', attachments: [{
      id: 'attachment-1',
      path: 'uploads/message/review.txt',
      mediaType: 'text/plain',
      bytes: 10,
      createdAt: fixedNow.toISOString(),
      sourceRunId: 'run-1',
      file: { bucket: 'private-bucket', key: 'private-key', sha256: 'c'.repeat(64) },
    }] };
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(store.listTranscript).mockResolvedValue({
      items: [
        {
          version: '1',
          itemType: 'transcript',
          conversationId: record.conversationId,
          entryId: 'assistant-1',
          role: 'assistant',
          contentKind: 'text',
          content: { bucket: 'private', key: 'answer', sha256: 'd'.repeat(64) },
          occurredAt: '2026-08-03T12:00:02.000Z',
          expiresAt: record.expiresAt,
        },
        {
          version: '1',
          itemType: 'transcript',
          conversationId: record.conversationId,
          entryId: 'user-1',
          role: 'user',
          contentKind: 'message',
          content: { bucket: 'private', key: 'message', sha256: 'e'.repeat(64) },
          occurredAt: '2026-08-03T12:00:01.000Z',
          expiresAt: record.expiresAt,
          messageId: 'message-1',
        },
      ],
      nextToken: 'older',
    });
    vi.mocked(artifacts.getJson).mockResolvedValue(userBody);
    vi.mocked(artifacts.getBytes).mockResolvedValue(Buffer.from('Complete.'));

    const detail = await service.getPublicDetail('api:owner-1', 'a'.repeat(64), {
      limit: 2,
      nextToken: 'cursor',
    });

    expect(store.listTranscript).toHaveBeenCalledWith(record.conversationId, 2, 'cursor');
    expect(detail?.transcript).toEqual({
      messages: [
        {
          role: 'user',
          content: 'Review this.',
          messageId: 'message-1',
          receivedAt: '2026-08-03T12:00:01.000Z',
          attachmentIds: ['attachment-1'],
        },
        {
          role: 'assistant',
          content: 'Complete.',
          receivedAt: '2026-08-03T12:00:02.000Z',
        },
      ],
      nextToken: 'older',
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

  it('stores a durable artifact catalog while completing a turn', async () => {
    const { service, store, writes } = harness();
    vi.mocked(store.getConversation).mockResolvedValue(conversation());
    vi.mocked(store.completeTurn).mockImplementation(async (input) => ({
      ...turn(),
      state: 'completed',
      ...(input.result ? { result: input.result } : {}),
    }));
    const result = {
      bucket: 'artifacts',
      key: 'result.md',
      sha256: 'a'.repeat(64),
    };

    await service.completeTurn({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      leaseToken: lease.token,
      result,
      context: {
        version: '1',
        messages: [{ role: 'assistant', content: 'Release evidence is ready.' }],
      },
      artifactCatalog: {
        version: '1',
        files: [{
          id: createHash('sha256').update('screens/home.png').digest('hex').slice(0, 24),
          path: 'screens/home.png',
          mediaType: 'image/png',
          bytes: 12,
          createdAt: fixedNow.toISOString(),
          sourceRunId: 'run-1',
          file: {
            bucket: 'artifacts',
            key: 'home.png',
            sha256: 'c'.repeat(64),
          },
        }],
      },
    });

    const catalogWrite = writes.find(({ key }) => key.includes('/artifacts/'));
    expect(catalogWrite?.value).toContain('screens/home.png');
    expect(store.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({ key: catalogWrite?.key }),
      transcript: expect.objectContaining({
        role: 'assistant',
        contentKind: 'text',
        content: result,
      }),
      search: expect.arrayContaining([
        expect.objectContaining({ token: 'release', kind: 'message', role: 'assistant' }),
        expect.objectContaining({ token: 'screens', kind: 'file' }),
      ]),
    }));
  });
});
