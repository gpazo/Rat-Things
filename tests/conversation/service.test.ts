import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../../src/conversation/service.js';
import {
  ConversationLeaseError,
  type ConversationStore,
} from '../../src/conversation/types.js';
import type { ArtifactStore, Clock } from '../../src/core/ports.js';
import type {
  ConversationCheckpoint,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationTranscriptRecord,
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
    getTranscriptTurn: vi.fn(),
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
  it('validates admission before time and storage, then validates policy after storing content', async () => {
    const { service, store, artifacts, writes } = harness();
    const now = vi.spyOn(clock, 'now');
    await expect(service.appendMessage({ ...messageInput(), content: { text: '' } })).rejects.toThrow('message requires text or attachments');
    expect(now).not.toHaveBeenCalled();
    await expect(service.appendMessage({ ...messageInput(), receivedAt: 'invalid' })).rejects.toThrow('receivedAt must be an ISO date');
    expect(now).toHaveBeenCalledTimes(1);
    expect(artifacts.putBytes).not.toHaveBeenCalled();

    const invalidPolicy = { ...messageInput(), executionPolicy: JSON.parse('{"outputSchema":{}}') };
    const failure = new Error('content unavailable');
    vi.mocked(artifacts.putBytes).mockRejectedValueOnce(failure);
    await expect(service.appendMessage(invalidPolicy)).rejects.toBe(failure);
    await expect(service.appendMessage(invalidPolicy)).rejects.toThrow('conversation execution policy cannot define an output schema');
    expect(writes).toHaveLength(1);
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it('writes a message body before its mailbox bundle and preserves persistence failures', async () => {
    const { service, store, artifacts } = harness();
    const events: string[] = [];
    vi.spyOn(clock, 'now').mockImplementation(() => { events.push('clock'); return fixedNow; });
    const put = artifacts.putBytes;
    vi.mocked(artifacts.putBytes).mockImplementation(async (...args) => {
      events.push('content');
      return { bucket: 'artifacts', key: args[0], sha256: 'a'.repeat(64) };
    });
    const failure = new Error('mailbox unavailable');
    vi.mocked(store.appendMessage).mockImplementation(async () => { events.push('mailbox'); throw failure; });
    await expect(service.appendMessage(messageInput())).rejects.toBe(failure);
    expect(events).toEqual(['clock', 'content', 'mailbox']);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('checks upload batch size and conversation ownership before inspecting file content', async () => {
    const { service, store, artifacts } = harness();
    const now = vi.spyOn(clock, 'now');
    await expect(service.prepareAttachments({ ...uploadInput(), uploads: [] })).rejects.toThrow('attachments must contain 1-6 files');
    expect(store.getConversation).not.toHaveBeenCalled();
    vi.mocked(store.getConversation).mockResolvedValue(conversation({ ownerId: 'other-owner' }));
    await expect(service.prepareAttachments({ ...uploadInput(), uploads: [upload('../invalid')] }))
      .rejects.toThrow('conversation belongs to another owner');
    expect(now).not.toHaveBeenCalled();
    expect(artifacts.putBytes).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'normalized duplicate', second: upload('ｎｏｔｅｓ.txt'), error: 'attachment name notes.txt is duplicated' },
    { name: 'bad checksum', second: { ...upload('other.txt'), sha256: 'a'.repeat(64) }, error: 'attachment other.txt checksum is invalid' },
    { name: 'bad media type', second: { ...upload('other.txt'), mediaType: 'text/plain\r\ninvalid' }, error: 'attachment media type is invalid' },
  ])('retains the first upload when the next file has a $name', async ({ second, error }) => {
    const { service, writes } = harness();
    await expect(service.prepareAttachments({ ...uploadInput(), uploads: [upload('notes.txt'), second] })).rejects.toThrow(error);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toContain('/blobs/sha256/');
  });

  it('stops after a failed upload write before validating later files or committing a manifest', async () => {
    const { service, artifacts } = harness();
    const failure = new Error('blob unavailable');
    vi.mocked(artifacts.putBytes).mockRejectedValueOnce(failure);
    await expect(service.prepareAttachments({ ...uploadInput(), uploads: [upload('notes.txt'), upload('../invalid')] }))
      .rejects.toBe(failure);
    expect(artifacts.putBytes).toHaveBeenCalledTimes(1);
  });

  it('writes every upload before its manifest and validates the resulting catalog before committing it', async () => {
    const { service, writes } = harness();
    const input = { ...uploadInput(), uploads: [upload('notes.txt', ''), upload('other.txt')] };
    const prepared = await service.prepareAttachments(input);
    expect(writes.map(({ key }) => key.includes('/attachment-manifests/') ? 'manifest' : 'blob')).toEqual(['blob', 'blob', 'manifest']);
    expect(prepared.files[0]).toMatchObject({ bytes: 0, mediaType: 'text/plain' });
    writes.length = 0;
    await expect(service.prepareAttachments({ ...input, sourceRunId: 'invalid:run' })).rejects.toThrow('invalid source run');
    expect(writes).toHaveLength(2);
    expect(writes.every(({ key }) => key.includes('/blobs/sha256/'))).toBe(true);
  });

  it('does not read a previous catalog for an empty attachment merge and retains the lease check', async () => {
    const { service, store, artifacts } = harness();
    const current = conversation();
    vi.mocked(store.getConversation).mockResolvedValue(current);
    await expect(service.attachArtifacts({ conversationId: current.conversationId, leaseToken: lease.token, files: [] })).resolves.toBe(current);
    await expect(service.attachArtifacts({ conversationId: current.conversationId, leaseToken: 'stale', files: [] }))
      .rejects.toBeInstanceOf(ConversationLeaseError);
    expect(artifacts.getJson).not.toHaveBeenCalled();
    expect(artifacts.putBytes).not.toHaveBeenCalled();
    expect(store.updateArtifacts).not.toHaveBeenCalled();
  });

  it('leaves catalog content durable when its conditional attachment update fails', async () => {
    const { service, store, artifacts, writes } = harness();
    const prepared = await service.prepareAttachments(uploadInput());
    const current = conversation();
    vi.mocked(store.getConversation).mockResolvedValue(current);
    const failure = new Error('lease changed');
    vi.mocked(store.updateArtifacts).mockRejectedValueOnce(failure);
    writes.length = 0;
    await expect(service.attachArtifacts({ conversationId: current.conversationId, leaseToken: lease.token, files: prepared.files }))
      .rejects.toBe(failure);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toContain('/artifacts/');
    expect(artifacts.getJson).not.toHaveBeenCalled();
    expect(store.updateArtifacts).toHaveBeenCalledWith(expect.objectContaining({ expectedToken: lease.token,
      artifacts: expect.objectContaining({ key: writes[0]?.key }) }));
  });

  it('loads detail dependencies concurrently, then receipts, bodies, and owner reactions in that order', async () => {
    const { service, store, artifacts } = harness();
    const events: string[] = [];
    const checkpoint = deferred<ConversationCheckpoint>();
    const completion = deferred<ConversationTurnRecord | undefined>();
    const record = conversation({ ownerId: 'owner-1', activeTurnId: 'turn-active',
      context: { bucket: 'private', key: 'context', sha256: 'a'.repeat(64) } });
    const assistant = transcriptRecord({ entryId: 'assistant', messageId: 'assistant-1' });
    const user = transcriptRecord({ entryId: 'user', role: 'user', contentKind: 'message', messageId: 'user-1' });
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(artifacts.getJson).mockImplementation(async (reference) => {
      if (reference.key === 'context') { events.push('checkpoint'); return checkpoint.promise; }
      events.push('message-body');
      return { text: 'Review this' };
    });
    vi.mocked(store.getTurn).mockImplementation(async () => { events.push('active-turn'); return turn(); });
    vi.mocked(store.listTranscript).mockImplementation(async () => {
      events.push('transcript-page'); return { items: [assistant, user], nextToken: 'older' };
    });
    vi.mocked(store.getTranscriptTurn).mockImplementation(async () => { events.push('receipt'); return completion.promise; });
    vi.mocked(artifacts.getBytes).mockImplementation(async () => { events.push('text-body'); return Buffer.from('Done'); });
    vi.mocked(store.listReactions).mockImplementation(async () => { events.push('reactions'); return []; });

    const detail = service.getPublicDetail('owner-1', 'a'.repeat(64), { limit: 2, nextToken: 'cursor' });
    await vi.waitFor(() => expect(events).toEqual(['checkpoint', 'active-turn', 'transcript-page']));
    checkpoint.resolve({ version: '1', messages: [] });
    await vi.waitFor(() => expect(events).toEqual(['checkpoint', 'active-turn', 'transcript-page', 'receipt']));
    completion.resolve(turn({ runId: 'run-1', state: 'completed', completedAt: fixedNow.toISOString() }));
    await expect(detail).resolves.toMatchObject({ transcript: {
      messages: [{ content: 'Review this', messageId: 'user-1' }, { content: 'Done', messageId: 'assistant-1' }],
      completions: [{ runId: 'run-1', status: 'succeeded' }], nextToken: 'older',
    } });
    expect(events).toEqual(['checkpoint', 'active-turn', 'transcript-page', 'receipt', 'text-body', 'message-body', 'reactions']);
    expect(store.listTranscript).toHaveBeenCalledWith(record.conversationId, 2, 'cursor');
    expect(store.listReactions).toHaveBeenCalledWith(record.conversationId, 'owner-1', ['user-1', 'assistant-1']);
  });

  it('stops after a failed completion read before loading transcript bodies or reactions', async () => {
    const { service, store, artifacts } = harness();
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(conversation({ ownerId: 'owner-1' }));
    vi.mocked(store.listTranscript).mockResolvedValue({ items: [transcriptRecord()] });
    const failure = new Error('turn receipt unavailable');
    vi.mocked(store.getTranscriptTurn).mockRejectedValue(failure);
    await expect(service.getPublicDetail('owner-1', 'a'.repeat(64))).rejects.toBe(failure);
    expect(artifacts.getJson).not.toHaveBeenCalled();
    expect(artifacts.getBytes).not.toHaveBeenCalled();
    expect(store.listReactions).not.toHaveBeenCalled();
  });

  it('preserves cursors and completion receipts when loaded content has no visible messages', async () => {
    const { service, store, artifacts } = harness();
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(conversation({ ownerId: 'owner-1' }));
    vi.mocked(store.listTranscript).mockResolvedValue({ items: [
      transcriptRecord({ contentKind: 'turn', messageId: 'assistant-1' }),
      transcriptRecord({ contentKind: 'message', role: 'user', entryId: 'malformed', messageId: 'user-1' }),
    ], nextToken: 'older' });
    vi.mocked(store.getTranscriptTurn).mockResolvedValue(turn({ runId: 'run-1', state: 'completed', completedAt: fixedNow.toISOString() }));
    vi.mocked(artifacts.getJson).mockResolvedValueOnce([]).mockResolvedValueOnce({ text: 0 });
    await expect(service.getPublicDetail('owner-1', 'a'.repeat(64))).resolves.toMatchObject({
      transcript: { messages: [], completions: [{ runId: 'run-1', status: 'succeeded' }], nextToken: 'older' },
    });
    expect(store.listReactions).not.toHaveBeenCalled();
  });

  it('rejects unsearchable queries before accessing the search store', async () => {
    const { service, store } = harness();
    for (const query of [' ', 'a ! 1', 'x'.repeat(513)]) {
      expect(() => service.search('owner-1', query)).toThrow();
    }
    expect(store.search).not.toHaveBeenCalled();
  });

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
      transcript: { messages: [], completions: [] },
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

  it('restores page-scoped completion receipts only after checking ownership', async () => {
    const {service, store, artifacts} = harness();
    const record = conversation({ownerId: 'api:owner-1'});
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(record);
    vi.mocked(store.listTranscript).mockResolvedValue({items: [{
      version: '1', itemType: 'transcript', conversationId: record.conversationId,
      entryId: 'turn-1', turnId: 'turn-private', runStatus: 'cancelled', role: 'assistant', contentKind: 'turn',
      content: {bucket: 'private', key: 'turn.json', sha256: 'a'.repeat(64)},
      occurredAt: record.updatedAt, expiresAt: record.expiresAt,
    }], nextToken: 'older'});
    vi.mocked(store.getTranscriptTurn).mockResolvedValue(turn({state: 'completed', runId: 'run-public', completedAt: fixedNow.toISOString()}));
    vi.mocked(artifacts.getJson).mockResolvedValue([]);
    expect(await service.getPublicDetail('api:other', 'a'.repeat(64))).toBeUndefined();
    expect(store.getTranscriptTurn).not.toHaveBeenCalled();
    const detail = await service.getPublicDetail('api:owner-1', 'a'.repeat(64));
    expect(detail?.transcript).toEqual({messages: [], nextToken: 'older', completions: [{runId: 'run-public', status: 'cancelled', startedAt: fixedNow.toISOString(), completedAt: fixedNow.toISOString()}]});
    expect(JSON.stringify(detail?.transcript)).not.toMatch(/private|turnId|bucket/);
  });

  it('keeps a durable receipt entry even when a terminal turn has no output', async () => {
    const {service, store, writes} = harness();
    vi.mocked(store.getConversation).mockResolvedValue(conversation());
    await service.completeTurn({conversationId: 'conversation-1', turnId: 'turn-empty', leaseToken: lease.token});
    await service.failTurn({conversationId: 'conversation-1', turnId: 'turn-stopped', leaseToken: lease.token, runStatus: 'cancelled', error: {code: 'agent_cancelled', message: 'Stopped', retryable: false}});
    expect(store.completeTurn).toHaveBeenCalledWith(expect.objectContaining({transcript: expect.objectContaining({turnId: 'turn-empty', runStatus: 'succeeded', contentKind: 'turn'})}));
    expect(store.failTurn).toHaveBeenCalledWith(expect.objectContaining({transcript: expect.objectContaining({turnId: 'turn-stopped', runStatus: 'cancelled', contentKind: 'turn'})}));
    expect(writes.filter(item => item.key.includes('/transcripts/')).map(item => item.value)).toEqual(['[]', '[]']);
  });

  it('validates renamed titles and keeps ownership checks in the service', async () => {
    const {service, store} = harness();
    vi.mocked(store.getConversationByPublicId).mockResolvedValue(conversation({ownerId: 'api:owner-1'}));
    await service.updateOrganization('api:owner-1', 'a'.repeat(64), {title: '  Résumé  '});
    expect(store.updateOrganization).toHaveBeenCalledWith(expect.objectContaining({title: 'Résumé'}));
    for (const title of [' ', 'x'.repeat(129)]) await expect(service.updateOrganization('api:owner-1', 'a'.repeat(64), {title})).rejects.toThrow();
    vi.mocked(store.updateOrganization).mockClear();
    expect(await service.updateOrganization('api:other', 'a'.repeat(64), {title: 'Changed'})).toBeUndefined();
    expect(store.updateOrganization).not.toHaveBeenCalled();
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
      completions: [],
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

function transcriptRecord(patch: Partial<ConversationTranscriptRecord> = {}): ConversationTranscriptRecord {
  return {
    version: '1', itemType: 'transcript', conversationId: 'conversation-1', entryId: 'entry-1',
    role: 'assistant', contentKind: 'text', occurredAt: fixedNow.toISOString(), expiresAt: 1_800_000_000,
    content: { bucket: 'private', key: 'body', sha256: 'a'.repeat(64) }, ...patch,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('promise is not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function messageInput() {
  return { conversationId: 'conversation-1', ownerId: 'owner-1', messageId: 'message-1', delivery: 'defer' as const,
    content: { text: 'Review the queue' }, source, destination: { kind: 'source' as const }, actor, credentialSubject };
}

function upload(name = 'notes.txt', text = 'saved content') {
  const bytes = Buffer.from(text);
  return { name, mediaType: 'text/plain', bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function uploadInput() {
  return { conversationId: 'conversation-1', ownerId: 'owner-1', messageId: 'message-1', sourceRunId: 'run-1', uploads: [upload()] };
}
