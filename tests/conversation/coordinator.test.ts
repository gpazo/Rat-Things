import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore, RunStore } from '../../src/core/ports.js';
import type { RunService } from '../../src/core/run-service.js';
import {
  ConversationCompletionCoordinator,
  ConversationCoordinator,
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
  it('turns mailbox state into a trusted resumable run and consumes only after scheduling', async () => {
    const conversations = {
      acquireLease: vi.fn().mockResolvedValue({ status: 'acquired', conversation, lease }),
      getTurn: vi.fn().mockResolvedValue(undefined),
      beginTurn: vi.fn().mockResolvedValue(turn),
      pending: vi.fn().mockResolvedValue([{
        messageId: 'message-1',
        receivedAt: conversation.createdAt,
        content: artifact('message.json'),
      }]),
      scheduleRun: vi.fn().mockResolvedValue({ ...turn, runId: 'run-1' }),
      releaseLease: vi.fn().mockResolvedValue({ ...conversation, lease: undefined }),
    } as unknown as ConversationService;
    const artifacts = {
      getJson: vi.fn().mockResolvedValue({ text: 'Inspect the deployment.' }),
      putJson: vi.fn().mockResolvedValue(artifact('continuation.json')),
      putBytes: vi.fn(),
    } as unknown as ArtifactStore;
    const submit = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const wake = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ConversationCoordinator({
      conversations,
      artifacts,
      runs: { submit, wake } as unknown as Pick<RunService, 'submit' | 'wake'>,
    });

    await expect(coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'trace-1',
    })).resolves.toEqual({ status: 'scheduled', runId: 'run-1' });

    expect(submit).toHaveBeenCalledWith(
      conversation.ownerId,
      expect.objectContaining({
        source: conversation.source,
        destinations: [{ kind: 'source' }],
        prompt: expect.stringContaining('Inspect the deployment.'),
        agent: { driver: 'mock', sandbox: 'workspace-write' },
      }),
      expect.objectContaining({
        enqueue: false,
        conversation: expect.objectContaining({
          conversationId: conversation.conversationId,
          turnId: turn.turnId,
          preferredMicrovmId: 'microvm-1',
          agentThreadId: 'thread-1',
          continuation: artifact('continuation.json'),
          artifacts: artifact('artifact-catalog.json'),
        }),
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
    submit.mockClear();

    await coordinator.handle({
      version: '1',
      conversationId: conversation.conversationId,
      traceId: 'trace-2',
    });

    expect(submit).toHaveBeenCalledWith(
      conversation.ownerId,
      expect.anything(),
      expect.objectContaining({
        conversation: expect.objectContaining({
          agentThreadId: 'thread-1',
        }),
      }),
    );
    expect(submit.mock.calls[0]?.[2].conversation).not.toHaveProperty('preferredMicrovmId');
  });

  it('folds terminal output into history, suspends the VM, and wakes queued follow-up work', async () => {
    const output = artifact('result.md');
    const continuation = artifact('continuation.json');
    const run: RunRecord = {
      runId: 'run-1',
      ownerId: conversation.ownerId,
      ownerCreated: `${conversation.ownerId}#${conversation.createdAt}#run-1`,
      status: 'succeeded',
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
      status: 'succeeded',
      occurredAt: run.updatedAt,
    })).resolves.toEqual({ status: 'completed' });

    expect(conversations.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      result: output,
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
});
