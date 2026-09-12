import { describe, expect, it, vi } from 'vitest';
import {
  ConversationCompletionCoordinator,
  ConversationCoordinator,
  parseConversationWakeMessage,
  type ConversationCompletionOptions,
  type ConversationCoordinatorOptions,
} from '../../src/conversation/coordinator.js';
import type { ArtifactReference, RunRecord, RunStateEvent } from '../../src/domain/contracts.js';
import { artifact, conversation, lease, message, run, timestamp, toolCall, turn } from './fixtures.js';

describe('completion effect boundaries', () => {
  it('suspends before reading evidence, settles before waking pending work, and reads time once', async () => {
    const fixture = completionHarness(run(), conversation({ pendingCount: 1 }));
    await expect(fixture.handle()).resolves.toEqual({ status: 'completed' });
    expect(fixture.effects).toEqual([
      'run', 'acquire', 'turn', 'suspend', 'events', 'output',
      'read:context.json', 'read:continuation.json', 'clock', 'complete', 'latest', 'wake',
    ]);
    expect(fixture.options.conversations.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      artifactCatalog: { version: '1', files: [] },
      session: expect.objectContaining({ id: 'microvm-1' }),
    }));
    expect(fixture.options.conversations.releaseLease).not.toHaveBeenCalled();
  });

  it('keeps an unsuccessful suspension retryable and preserves the error if lease cleanup also fails', async () => {
    const fixture = completionHarness();
    const failure = new Error('Suspend unavailable');
    fixture.options.sessions.suspend.mockRejectedValueOnce(failure);
    fixture.options.conversations.releaseLease.mockRejectedValueOnce(new Error('Cleanup unavailable'));
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(fixture.handle()).rejects.toBe(failure);
      expect(fixture.options.artifacts.getBytes).not.toHaveBeenCalled();
      expect(fixture.options.results.read).not.toHaveBeenCalled();
      expect(fixture.options.conversations.completeTurn).not.toHaveBeenCalled();
      expect(fixture.options.conversations.failTurn).not.toHaveBeenCalled();
      expect(fixture.options.conversations.releaseLease).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"CleanupFailure":1'));
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['succeeded', ['context.json', 'continuation.json']],
    ['failed', ['context.json']],
  ] as const)('preserves %s read scheduling when the context read rejects', async (status, keys) => {
    const fixture = completionHarness(run({ status }));
    const failure = new Error('Context unavailable');
    fixture.options.artifacts.getJson.mockRejectedValueOnce(failure);
    await expect(fixture.handle()).rejects.toBe(failure);
    expect(fixture.options.artifacts.getJson.mock.calls.map(([reference]) => reference.key)).toEqual(keys);
    expect(fixture.options.conversations.completeTurn).not.toHaveBeenCalled();
    expect(fixture.options.conversations.failTurn).not.toHaveBeenCalled();
    expect(fixture.options.clock.now).not.toHaveBeenCalled();
    expect(fixture.options.conversations.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('does not read final output when the earlier events read fails', async () => {
    const fixture = completionHarness();
    const failure = new Error('Events unavailable');
    fixture.options.artifacts.getBytes.mockRejectedValueOnce(failure);
    await expect(fixture.handle()).rejects.toBe(failure);
    expect(fixture.options.results.read).not.toHaveBeenCalled();
    expect(fixture.options.artifacts.getJson).not.toHaveBeenCalled();
    expect(fixture.options.conversations.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('does not load context or read the clock for a failure without output or interrupted tools', async () => {
    const { result: _result, ...record } = run({ status: 'failed' });
    const fixture = completionHarness(record);
    await fixture.handle();
    expect(fixture.options.artifacts.getJson).not.toHaveBeenCalled();
    expect(fixture.options.artifacts.getBytes).not.toHaveBeenCalled();
    expect(fixture.options.results.read).not.toHaveBeenCalled();
    expect(fixture.options.clock.now).not.toHaveBeenCalled();
    const settlement = fixture.options.conversations.failTurn.mock.calls[0]?.[0];
    expect(settlement).not.toHaveProperty('context');
    expect(settlement).not.toHaveProperty('session');
    expect(settlement).not.toHaveProperty('clearSession');
    expect(fixture.options.queue.enqueue).not.toHaveBeenCalled();
  });

  it('retains failed output and an identified native thread, while keeping empty output empty', async () => {
    const fixture = completionHarness(run({ status: 'failed' }));
    fixture.options.results.read.mockResolvedValueOnce('');
    await fixture.handle();
    expect(fixture.options.conversations.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ messages: [{ role: 'assistant', content: '' }] }),
      session: expect.objectContaining({ agentThreadId: 'thread-1' }),
      artifactCatalog: { version: '1', files: [] },
    }));
    expect(fixture.options.clock.now).toHaveBeenCalledTimes(1);
  });

  it('clears native resume for interrupted tools even if a successful Run saved a result', async () => {
    const fixture = completionHarness(run({ agentToolCalls: [toolCall()] }));
    await fixture.handle();
    expect(fixture.options.conversations.completeTurn).not.toHaveBeenCalled();
    expect(fixture.options.conversations.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      clearSession: true,
      context: expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('The external outcome is unknown') }),
      ]) }),
    }));
    expect(fixture.options.conversations.failTurn.mock.calls[0]?.[0]).not.toHaveProperty('session');
    expect(fixture.options.clock.now).not.toHaveBeenCalled();
  });

  it('does not suspend or read evidence when a completion belongs to an older turn', async () => {
    const fixture = completionHarness();
    fixture.options.conversations.getTurn.mockResolvedValueOnce(turn({ runId: 'another-run' }));
    await expect(fixture.handle()).resolves.toEqual({ status: 'stale' });
    expect(fixture.effects).toEqual(['run', 'acquire', 'release']);
    expect(fixture.options.sessions.suspend).not.toHaveBeenCalled();
    expect(fixture.options.artifacts.getBytes).not.toHaveBeenCalled();
  });
});

describe('preparation effect boundaries', () => {
  it.each([
    ['future', true, 1], ['equal', false, 1], ['expired', false, 1], ['invalid', false, 1],
    ['unknown', false, 0], ['unbounded', true, 0], ['missing', false, 0],
  ] as const)('checks a %s VM lease using only the required clock reads', async (kind, preferred, reads) => {
    const record = conversation();
    if (kind === 'missing') delete record.session;
    else {
      const session = record.session!;
      if (kind === 'unknown') session.id = 'unknown';
      else if (kind === 'unbounded') delete session.expiresAt;
      else session.expiresAt = {
        future: '2026-08-03T12:00:00.001Z', equal: timestamp,
        expired: '2026-08-03T11:59:59.999Z', invalid: 'invalid-date',
      }[kind];
    }
    const fixture = preparationHarness(record);
    await fixture.handle();
    expect(fixture.options.clock.now).toHaveBeenCalledTimes(reads);
    const binding = fixture.options.runs.prepareConversation.mock.calls[0]?.[3];
    if (preferred) expect(binding?.preferredMicrovmId).toBe('microvm-1');
    else expect(binding).not.toHaveProperty('preferredMicrovmId');
    if (kind !== 'missing') expect(binding?.agentThreadId).toBe('thread-1');
    expect(fixture.options.conversations.pending).toHaveBeenCalledWith(record.conversationId, lease.token, { limit: 1 });
    expect(fixture.options.conversations.scheduleRun).toHaveBeenCalledBefore(fixture.options.runs.wake);
    expect(fixture.options.runs.wake).toHaveBeenCalledBefore(fixture.options.conversations.releaseLease);
  });

  it('does not wake a prepared Run until the mailbox binding has committed', async () => {
    const fixture = preparationHarness();
    const failure = new Error('Mailbox write unavailable');
    fixture.options.conversations.scheduleRun.mockRejectedValueOnce(failure);
    await expect(fixture.handle()).rejects.toBe(failure);
    expect(fixture.options.runs.prepareConversation).toHaveBeenCalledTimes(1);
    expect(fixture.options.runs.wake).not.toHaveBeenCalled();
    expect(fixture.options.conversations.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched reservation before preparing or waking it', async () => {
    const fixture = preparationHarness();
    fixture.options.runs.get.mockResolvedValueOnce(run({ conversation: { conversationId: 'another-conversation', messageId: 'message-1' } }));
    await expect(fixture.handle()).rejects.toThrow('mailbox item is bound to a different thread Run');
    expect(fixture.options.runs.prepareConversation).not.toHaveBeenCalled();
    expect(fixture.options.runs.wake).not.toHaveBeenCalled();
    expect(fixture.options.clock.now).not.toHaveBeenCalled();
    expect(fixture.options.conversations.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('retains the public queue parser and rejects unpaired recovery identity', () => {
    const wake = { version: '1', conversationId: 'conversation-1', traceId: 'trace-1' };
    expect(parseConversationWakeMessage(JSON.stringify(wake))).toEqual(wake);
    expect(() => parseConversationWakeMessage(JSON.stringify({ ...wake, runId: 'run-1' })))
      .toThrow('invalid conversation queue message');
  });
});

function completionHarness(record: RunRecord = run(), thread = conversation()) {
  const effects: string[] = [];
  const options = {
    conversations: {
      acquireLease: vi.fn(async () => { effects.push('acquire'); return { status: 'acquired' as const, conversation: thread, lease }; }),
      getTurn: vi.fn(async () => { effects.push('turn'); return turn({ runId: record.runId }); }),
      completeTurn: vi.fn(async (_input: Parameters<ConversationCompletionOptions['conversations']['completeTurn']>[0]) => { effects.push('complete'); return turn({ state: 'completed' }); }),
      failTurn: vi.fn(async (_input: Parameters<ConversationCompletionOptions['conversations']['failTurn']>[0]) => { effects.push('fail'); return turn({ state: 'failed' }); }),
      releaseLease: vi.fn(async () => { effects.push('release'); return thread; }),
      get: vi.fn(async () => { effects.push('latest'); return thread; }),
    },
    runs: { get: vi.fn(async () => { effects.push('run'); return record; }) },
    artifacts: {
      getBytes: vi.fn(async () => { effects.push('events'); return Buffer.from(''); }),
      getJson: vi.fn(async (reference: Pick<ArtifactReference, 'bucket' | 'key'>) => {
        effects.push(`read:${reference.key}`);
        return { version: '1', messages: [] };
      }),
    },
    results: { read: vi.fn(async () => { effects.push('output'); return 'Saved output'; }) },
    sessions: { suspend: vi.fn(async () => { effects.push('suspend'); }) },
    queue: { enqueue: vi.fn(async () => { effects.push('wake'); }) },
    clock: { now: vi.fn(() => { effects.push('clock'); return new Date(timestamp); }) },
  };
  const coordinator = new ConversationCompletionCoordinator({
    ...options, artifacts: { ...options.artifacts, getJson: fixtureJsonReader(options.artifacts.getJson) },
  });
  const event: RunStateEvent = {
    version: '1', runId: record.runId, ownerId: record.ownerId, sourceKind: record.sourceKind,
    status: record.status, occurredAt: record.updatedAt,
  };
  return { effects, options, handle: () => coordinator.handle(event) };
}

function preparationHarness(thread = conversation()) {
  const options = {
    conversations: {
      acquireLease: vi.fn(async () => ({ status: 'acquired' as const, conversation: thread, lease })),
      getTurn: vi.fn(), resumeTurn: vi.fn(), beginTurn: vi.fn(async () => turn()),
      pending: vi.fn(async () => [message()]), attachArtifacts: vi.fn(),
      scheduleRun: vi.fn(async () => turn()), releaseLease: vi.fn(async () => thread),
      getMessage: vi.fn(), readAttachmentManifest: vi.fn(), appendMessage: vi.fn(),
    },
    runs: {
      get: vi.fn(async () => run({ status: 'queued' })),
      prepareConversation: vi.fn(async (..._args: Parameters<ConversationCoordinatorOptions['runs']['prepareConversation']>) => run()),
      wake: vi.fn(async () => undefined),
    },
    artifacts: {
      getJson: vi.fn(async (reference: Pick<ArtifactReference, 'bucket' | 'key'>) => (
        reference.key === 'context.json' ? { version: '1', messages: [] } : { text: 'Newest input' }
      )),
      putJson: vi.fn(async () => artifact('continuation.json')),
    },
    clock: { now: vi.fn(() => new Date(timestamp)) },
  };
  const coordinator = new ConversationCoordinator({
    ...options, artifacts: { ...options.artifacts, getJson: fixtureJsonReader(options.artifacts.getJson) },
  });
  return {
    options,
    handle: () => coordinator.handle({ version: '1', conversationId: thread.conversationId, traceId: 'trace-1' }),
  };
}

// The fixture controls the returned JSON shapes; adapt the spy to the storage port's generic read.
function fixtureJsonReader(
  read: (reference: Pick<ArtifactReference, 'bucket' | 'key'>) => Promise<unknown>,
): ConversationCompletionOptions['artifacts']['getJson'] {
  return async <T>(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T> => await read(reference) as T;
}
