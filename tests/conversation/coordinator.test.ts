import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore, RunStore } from '../../src/core/ports.js';
import type { RunService } from '../../src/core/run-service.js';
import {
  appendContext,
  ConversationCompletionCoordinator,
  ConversationCoordinator,
  replayPrompt,
} from '../../src/conversation/coordinator.js';
import type { ConversationService } from '../../src/conversation/service.js';
import type { ConversationRecord, ConversationTurnRecord } from '../../src/domain/conversations.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const lease = {
  token: 'lease-1',
  acquiredAt: '2026-08-03T12:00:00.000Z',
  checkedInAt: '2026-08-03T12:00:00.000Z',
  expiresAt: '2026-08-03T12:01:30.000Z',
};

const conversation: ConversationRecord = {
  version: '1',
  itemType: 'conversation',
  conversationId: 'teams:tenant:user:thread',
  ownerId: 'teams:tenant:user',
  status: 'pending',
  pendingCount: 1,
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
  expiresAt: 2_000_000_000,
  source: {
    kind: 'teams',
    tenantId: 'tenant',
    conversationId: 'thread',
    activityId: 'message-1',
    senderId: 'user',
  },
  destination: { kind: 'source' },
  actor: { kind: 'human', id: 'teams:tenant:user', provider: 'teams' },
  credentialSubject: { kind: 'runtime', id: 'runtime:teams' },
  executionPolicy: {
    driver: 'mock',
    sandbox: 'workspace-write',
  },
  artifacts: artifact('artifact-catalog.json'),
  lease,
  session: {
    backend: 'microvm',
    id: 'microvm-1',
    state: 'suspended',
    updatedAt: '2026-08-03T12:00:00.000Z',
    expiresAt: '2099-08-03T20:00:00.000Z',
    agentThreadId: 'thread-1',
  },
};

const turn: ConversationTurnRecord = {
  version: '1',
  itemType: 'turn',
  conversationId: conversation.conversationId,
  turnId: 'turn-1',
  state: 'running',
  slice: 0,
  startedAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  expiresAt: conversation.expiresAt,
};

function artifact(key: string) {
  return { bucket: 'artifacts', key, sha256: createHash('sha256').update(key).digest('hex') };
}

describe('conversation coordinator', () => {
  it('makes bounded replay loss explicit and accumulates compaction evidence', () => {
    const previous = {
      version: '1' as const,
      messages: Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history-${index}`,
      })),
      metadata: { compactedMessages: 7, preserved: 'value' },
    };
    const continuation = {
      version: '1' as const,
      messages: [{
        messageId: 'message-new',
        text: 'Newest request',
        receivedAt: conversation.createdAt,
      }],
    };

    const next = appendContext(previous, continuation, 'Newest response');

    expect(next.messages).toHaveLength(200);
    expect(next.metadata).toEqual({ compactedMessages: 9, preserved: 'value' });

    const prompt = replayPrompt({
      version: '1',
      messages: [
        { role: 'user', content: 'x'.repeat(90_000) },
        { role: 'assistant', content: 'recent response' },
      ],
      metadata: { compactedMessages: 9 },
    }, continuation);
    expect(prompt).toContain('9 older transcript item(s) were compacted');
    expect(prompt).toContain('1 retained item(s) were omitted');
    expect(prompt).toContain('do not invent omitted details');
    expect(prompt).toContain('Newest request');
    expect(prompt).not.toContain('x'.repeat(100));
  });

  it('turns mailbox state into a trusted resumable run and consumes only after scheduling', async () => {
    const conversations = {
      acquireLease: vi.fn().mockResolvedValue({ status: 'acquired', conversation, lease }),
      getTurn: vi.fn().mockResolvedValue(undefined),
      beginTurn: vi.fn().mockResolvedValue(turn),
      pending: vi.fn().mockResolvedValue([{
        messageId: 'message-1',
        runId: 'run-1',
        receivedAt: conversation.createdAt,
        content: artifact('message.json'),
        actor: conversation.actor,
        credentialSubject: conversation.credentialSubject,
      }]),
      scheduleRun: vi.fn().mockResolvedValue({ ...turn, runId: 'run-1' }),
      releaseLease: vi.fn().mockResolvedValue({ ...conversation, lease: undefined }),
    } as unknown as ConversationService;
    const artifacts = {
      getJson: vi.fn().mockResolvedValue({ text: 'Inspect the deployment.' }),
      putJson: vi.fn().mockResolvedValue(artifact('continuation.json')),
      putBytes: vi.fn(),
    } as unknown as ArtifactStore;
    const get = vi.fn().mockResolvedValue({
      runId: 'run-1',
      conversation: {
        conversationId: conversation.conversationId,
        messageId: 'message-1',
        delivery: 'defer',
      },
    });
    const prepareConversation = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const wake = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ConversationCoordinator({
      conversations,
      artifacts,
      runs: { get, prepareConversation, wake } as unknown as Pick<
        RunService,
        'get' | 'prepareConversation' | 'wake'
      >,
    });

    await expect(coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'trace-1',
    })).resolves.toEqual({ status: 'scheduled', runId: 'run-1' });

    expect(get).toHaveBeenCalledWith(conversation.ownerId, 'run-1');
    expect(prepareConversation).toHaveBeenCalledWith(
      conversation.ownerId,
      'run-1',
      expect.objectContaining({ prompt: expect.stringContaining('Inspect the deployment.') }),
      expect.objectContaining({
        conversationId: conversation.conversationId,
        messageId: 'message-1',
        turnId: turn.turnId,
        preferredMicrovmId: 'microvm-1',
        agentThreadId: 'thread-1',
        continuation: artifact('continuation.json'),
        artifacts: artifact('artifact-catalog.json'),
      }),
    );
    expect(vi.mocked(conversations.scheduleRun)).toHaveBeenCalledBefore(wake);
    expect(wake).toHaveBeenCalledWith('run-1', 'trace-1');
    expect(conversations.scheduleRun).toHaveBeenCalledWith(expect.objectContaining({
      messageIds: ['message-1'],
    }));
    expect(conversations.releaseLease).toHaveBeenCalled();

    const expiredConversation = {
      ...conversation,
      session: {
        ...conversation.session!,
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    };
    vi.mocked(conversations.acquireLease).mockResolvedValue({
      status: 'acquired',
      conversation: expiredConversation,
      lease,
    });
    get.mockClear();

    await coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'trace-2',
    });

    expect(prepareConversation).toHaveBeenLastCalledWith(
      conversation.ownerId,
      'run-1',
      expect.anything(),
      expect.objectContaining({
        agentThreadId: 'thread-1',
      }),
    );
    expect(prepareConversation.mock.calls.at(-1)?.[3]).not.toHaveProperty('preferredMicrovmId');
  });

  it('reports failed lease cleanup without replacing the coordination error', async () => {
    const coordinationError = new Error('run wake failed');
    const metricLines: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation((line) => {
      metricLines.push(String(line));
    });
    const conversations = {
      acquireLease: vi.fn().mockResolvedValue({
        status: 'acquired',
        conversation: { ...conversation, activeTurnId: turn.turnId },
        lease,
      }),
      getTurn: vi.fn().mockResolvedValue({ ...turn, runId: 'run-1' }),
      releaseLease: vi.fn().mockRejectedValue(new Error('Dynamo unavailable')),
    } as unknown as ConversationService;
    const coordinator = new ConversationCoordinator({
      conversations,
      artifacts: {} as ArtifactStore,
      runs: {
        get: vi.fn(),
        prepareConversation: vi.fn(),
        wake: vi.fn().mockRejectedValue(coordinationError),
      } as unknown as Pick<RunService, 'get' | 'prepareConversation' | 'wake'>,
    });
    try {
      await expect(coordinator.handle({
        version: '1',
        conversationId: conversation.conversationId,
        traceId: 'trace-cleanup',
      })).rejects.toBe(coordinationError);
      expect(metricLines.map((line) => JSON.parse(line) as unknown)).toContainEqual(
        expect.objectContaining({ Component: 'conversation-coordinator', CleanupFailure: 1 }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('reconstructs a missing mailbox write from the already accepted Run', async () => {
    const reserved: RunRecord = {
      runId: 'run-recovery',
      ownerId: conversation.ownerId,
      ownerCreated: `${conversation.ownerId}#${conversation.createdAt}#run-recovery`,
      status: 'queued',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      expiresAt: conversation.expiresAt,
      requestHash: 'a'.repeat(64),
      input: artifact('recovery-input.json'),
      sourceKind: 'teams',
      provenance: {
        actor: conversation.actor,
        credentialSubject: conversation.credentialSubject,
      },
      conversation: {
        conversationId: conversation.conversationId,
        messageId: 'message-recovery',
        delivery: 'defer',
      },
    };
    const request = {
      version: '1' as const,
      prompt: 'Recover this accepted request.',
      source: conversation.source,
      destinations: [conversation.destination],
      agent: conversation.executionPolicy,
    };
    const conversations = {
      getMessage: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockResolvedValue({ status: 'appended' }),
      acquireLease: vi.fn().mockResolvedValue({ status: 'busy' }),
    } as unknown as ConversationService;
    const artifacts = {
      getJson: vi.fn().mockResolvedValue(request),
    } as unknown as ArtifactStore;
    const coordinator = new ConversationCoordinator({
      conversations,
      artifacts,
      runs: {
        get: vi.fn().mockResolvedValue(reserved),
        prepareConversation: vi.fn(),
        wake: vi.fn(),
      } as unknown as Pick<RunService, 'get' | 'prepareConversation' | 'wake'>,
    });

    await expect(coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'reconcile:run-recovery',
      runId: reserved.runId,
      ownerId: reserved.ownerId,
    })).resolves.toEqual({ status: 'busy' });

    expect(conversations.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.conversationId,
      ownerId: conversation.ownerId,
      messageId: 'message-recovery',
      runId: reserved.runId,
      delivery: 'defer',
      content: expect.objectContaining({ text: request.prompt, request }),
      source: conversation.source,
      destination: conversation.destination,
    }));
  });

  it('acknowledges stale wake-ups for cancelled mailbox reservations', async () => {
    const conversations = {
      appendMessage: vi.fn(),
      acquireLease: vi.fn().mockResolvedValue({ status: 'no_work' }),
    } as unknown as ConversationService;
    const runs = {
      get: vi.fn().mockResolvedValue({
        runId: 'run-rejected',
        ownerId: conversation.ownerId,
        status: 'cancelled',
        conversation: {
          conversationId: conversation.conversationId,
          messageId: 'message-rejected',
        },
      }),
      prepareConversation: vi.fn(),
      wake: vi.fn(),
    } as unknown as Pick<RunService, 'get' | 'prepareConversation' | 'wake'>;
    const coordinator = new ConversationCoordinator({
      conversations,
      artifacts: {} as ArtifactStore,
      runs,
    });

    await expect(coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'reconcile:run-rejected',
      runId: 'run-rejected',
      ownerId: conversation.ownerId,
    })).resolves.toEqual({ status: 'no_work' });

    expect(conversations.appendMessage).not.toHaveBeenCalled();
    expect(conversations.acquireLease).toHaveBeenCalledWith(conversation.conversationId);
  });

  it.each(['succeeded', 'cancelled'] as const)('folds %s output, interactions, files, and native thread into durable history', async (status) => {
    const output = artifact('result.md');
    const continuation = artifact('continuation.json');
    const run: RunRecord = {
      runId: 'run-1',
      ownerId: conversation.ownerId,
      ownerCreated: `${conversation.ownerId}#${conversation.createdAt}#run-1`,
      status,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      expiresAt: conversation.expiresAt,
      requestHash: 'a'.repeat(64),
      input: artifact('run-input.json'),
      sourceKind: 'teams',
      conversation: {
        conversationId: conversation.conversationId,
        turnId: turn.turnId,
        slice: 0,
        continuation,
      },
      execution: { backend: 'microvm', id: 'microvm-1', startedAt: conversation.createdAt },
      result: {
        output,
        events: artifact('events.jsonl'),
        preview: 'Deployment is healthy.',
        exitCode: 0,
        durationMs: 100,
        agentThreadId: 'thread-2',
        artifacts: [{
          id: createHash('sha256').update('screens/home.png').digest('hex').slice(0, 24),
          path: 'screens/home.png',
          mediaType: 'image/png',
          bytes: 128,
          createdAt: conversation.createdAt,
          sourceRunId: 'run-1',
          file: artifact('home.png'),
        }],
      },
    };
    const activeConversation = { ...conversation, activeTurnId: turn.turnId };
    const conversations = {
      acquireLease: vi.fn().mockResolvedValue({
        status: 'acquired',
        conversation: activeConversation,
        lease,
      }),
      getTurn: vi.fn().mockResolvedValue({ ...turn, runId: run.runId }),
      completeTurn: vi.fn().mockResolvedValue({ ...turn, state: 'completed' }),
      releaseLease: vi.fn(),
      get: vi.fn().mockResolvedValue({ ...conversation, pendingCount: 1 }),
    } as unknown as ConversationService;
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const sessions = { suspend: vi.fn().mockResolvedValue(undefined) };
    const artifacts = {
      getBytes: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({method: 'rat/interaction', params: {role: 'user', text: 'Direction: focus on errors', occurredAt: conversation.createdAt}})+'\n')),
      getJson: vi.fn().mockResolvedValue({
        version: '1',
        messages: [{ messageId: 'message-1', text: 'Is it healthy?', receivedAt: conversation.createdAt }],
      }),
      putJson: vi.fn(),
      putBytes: vi.fn(),
    } as unknown as ArtifactStore;
    const completion = new ConversationCompletionCoordinator({
      conversations,
      runs: { get: vi.fn().mockResolvedValue(run) } as unknown as Pick<RunStore, 'get'>,
      artifacts,
      results: { read: vi.fn().mockResolvedValue('Deployment is healthy.') },
      queue,
      sessions,
      clock: { now: () => new Date('2026-08-03T12:10:00.000Z') },
    });

    await expect(completion.handle({
      version: '1',
      runId: run.runId,
      ownerId: run.ownerId,
      sourceKind: 'teams',
      status,
      occurredAt: run.updatedAt,
    })).resolves.toEqual({ status: 'completed' });

    expect(conversations.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      result: output,
      transcriptMessages: expect.arrayContaining([expect.objectContaining({role: 'user', content: 'Direction: focus on errors'})]),
      context: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'Is it healthy?' }),
          expect.objectContaining({ role: 'assistant', content: 'Deployment is healthy.' }),
        ]),
      }),
      artifactCatalog: expect.objectContaining({
        version: '1',
        files: [expect.objectContaining({ path: 'screens/home.png' })],
      }),
      session: expect.objectContaining({
        id: 'microvm-1',
        state: 'suspended',
        agentThreadId: 'thread-2',
      }),
    }));
    expect(sessions.suspend).toHaveBeenCalledWith('microvm-1');
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.conversationId,
    }));
  });

  it('persists an unknown-outcome handoff and drops native resume after an interrupted tool call', async () => {
    const continuation = artifact('interrupted-continuation.json');
    const run: RunRecord = {
      runId: 'run-interrupted',
      ownerId: conversation.ownerId,
      ownerCreated: `${conversation.ownerId}#${conversation.createdAt}#run-interrupted`,
      status: 'failed',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      expiresAt: conversation.expiresAt,
      requestHash: 'a'.repeat(64),
      input: artifact('interrupted-input.json'),
      sourceKind: 'teams',
      conversation: {
        conversationId: conversation.conversationId,
        turnId: turn.turnId,
        slice: 0,
        continuation,
      },
      execution: {
        backend: 'microvm',
        id: 'microvm-1',
        generation: 'b'.repeat(64),
      },
      agentToolCalls: [{
        version: '1',
        runId: 'run-interrupted',
        requestId: 'tool-unknown',
        method: 'item/tool/call',
        executionId: 'microvm-1',
        executionGeneration: 'b'.repeat(64),
        namespace: 'fixture_crm',
        tool: 'records_create',
        argumentDigest: 'c'.repeat(64),
        admittedToolsDigest: 'd'.repeat(64),
        status: 'interrupted',
        startedAt: '2026-08-03T12:00:01.000Z',
        settledAt: '2026-08-03T12:00:02.000Z',
        error: 'execution ended before settlement',
      }],
      error: { code: 'execution_lost', message: 'MicroVM terminated', retryable: true },
    };
    const activeConversation = { ...conversation, activeTurnId: turn.turnId };
    const conversations = {
      acquireLease: vi.fn().mockResolvedValue({
        status: 'acquired',
        conversation: activeConversation,
        lease,
      }),
      getTurn: vi.fn().mockResolvedValue({ ...turn, runId: run.runId }),
      failTurn: vi.fn().mockResolvedValue({ ...turn, state: 'failed' }),
      releaseLease: vi.fn(),
      get: vi.fn().mockResolvedValue({ ...conversation, pendingCount: 0 }),
    } as unknown as ConversationService;
    const artifacts = {
      getJson: vi.fn().mockResolvedValue({
        version: '1',
        messages: [{
          messageId: 'message-interrupted',
          text: 'Create the record once.',
          receivedAt: conversation.createdAt,
        }],
      }),
    } as unknown as ArtifactStore;
    const sessions = { suspend: vi.fn().mockResolvedValue(undefined) };
    const completion = new ConversationCompletionCoordinator({
      conversations,
      runs: { get: vi.fn().mockResolvedValue(run) } as unknown as Pick<RunStore, 'get'>,
      artifacts,
      results: { read: vi.fn() },
      queue: { enqueue: vi.fn() },
      sessions,
    });

    await expect(completion.handle({
      version: '1',
      runId: run.runId,
      ownerId: run.ownerId,
      sourceKind: 'teams',
      status: 'failed',
      occurredAt: run.updatedAt,
    })).resolves.toEqual({ status: 'completed' });

    expect(conversations.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      clearSession: true,
      context: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'Create the record once.' }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Do not replay any of these calls automatically'),
          }),
        ]),
      }),
    }));
    expect(sessions.suspend).toHaveBeenCalledWith('microvm-1');
  });
});
