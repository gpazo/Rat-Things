import { describe, expect, it, vi } from 'vitest';
import {
  apiConversationId,
  ConversationSubmissionService,
} from '../../src/app/conversation-submission.js';
import type { ConversationService } from '../../src/conversation/service.js';
import type { ConversationQueue } from '../../src/conversation/types.js';
import type { RunService } from '../../src/core/run-service.js';
import { apiIngressContext } from '../../src/identity/context.js';

describe('threaded Run submission', () => {
  it('appends thread state while returning the public Run immediately', async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockImplementation(async (input) => ({
        status: 'appended',
        conversation: {},
        message: { messageId: input.messageId },
      })),
    } as unknown as ConversationService;
    const queue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as ConversationQueue;
    const runs = runServices();
    const service = new ConversationSubmissionService(conversations, queue, runs);
    const context = apiIngressContext('api:arn:aws:iam::123456789012:user/operator');

    const runtimeId = apiConversationId(context.owner.id, 'headless-smoke');
    await expect(service.submitThread(
      context.owner.id,
      {
        version: '1',
        prompt: 'Use a shell command and report its output.',
        source: context.source,
        destinations: [{ kind: 'none' }],
        agent: {
        driver: 'codex',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
        capabilities: { networkAccess: true, computerUse: 'browser' },
        },
        integrations: {
          connections: [
            { connection: 'gmail-personal', preset: 'read-only' },
            { connection: 'gmail-business', preset: 'read-write' },
          ],
        },
      },
      {
        idempotencyKey: 'message-1',
        traceId: 'trace-1',
        provenance: {
          actor: context.actor,
          credentialSubject: context.credentialSubject,
        },
      },
      { conversationId: runtimeId, messageId: 'message-1' },
    )).resolves.toMatchObject({ runId: 'run-message-1' });

    expect(runtimeId).toMatch(/^api:[a-f0-9]{32}:headless-smoke$/);
    expect(conversations.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: runtimeId,
      ownerId: context.owner.id,
      messageId: 'message-1',
      runId: 'run-message-1',
      delivery: 'defer',
      content: expect.objectContaining({
        text: 'Use a shell command and report its output.',
        request: expect.objectContaining({ version: '1' }),
      }),
      source: { kind: 'api' },
      destination: { kind: 'none' },
      actor: context.actor,
      credentialSubject: context.credentialSubject,
      executionPolicy: {
        driver: 'codex',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
        capabilities: { networkAccess: true, computerUse: 'browser' },
      },
      integrationPolicy: {
        connections: [
          { connection: 'gmail-personal', preset: 'read-only' },
          { connection: 'gmail-business', preset: 'read-write' },
        ],
      },
    }));
    expect(runs.submit).toHaveBeenCalledWith(
      context.owner.id,
      expect.objectContaining({ prompt: 'Use a shell command and report its output.' }),
      expect.objectContaining({
        idempotencyKey: 'message-1',
        enqueue: false,
        conversation: expect.objectContaining({ messageId: 'message-1' }),
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith({
      version: '1',
      conversationId: runtimeId,
      traceId: 'trace-1',
      runId: 'run-message-1',
      ownerId: context.owner.id,
    });
  });

  it('prioritizes a message arriving during an active turn', async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue({ activeTurnId: 'turn-1' }),
      getMessage: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockImplementation(async (input) => ({
        status: 'duplicate',
        conversation: {},
        message: { messageId: input.messageId },
      })),
    } as unknown as ConversationService;
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) } as ConversationQueue;
    const service = new ConversationSubmissionService(conversations, queue, runServices());

    const context = apiIngressContext('api:operator');
    await service.submitThread(
      context.owner.id,
      { version: '1', prompt: 'Follow up now.', source: context.source },
      {
        idempotencyKey: 'message-2',
        traceId: 'trace-2',
        provenance: { actor: context.actor, credentialSubject: context.credentialSubject },
      },
      {
        conversationId: apiConversationId(context.owner.id, 'headless-smoke'),
        messageId: 'message-2',
      },
    );

    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: 'interrupt' }),
    );
  });

  it('retains the original delivery priority when an idempotent retry races a turn start', async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue({ activeTurnId: 'turn-1' }),
      getMessage: vi.fn().mockResolvedValue({
        messageId: 'message-1',
        delivery: 'defer',
      }),
      appendMessage: vi.fn().mockImplementation(async (input) => ({
        status: 'duplicate',
        conversation: {},
        message: { messageId: input.messageId },
      })),
    } as unknown as ConversationService;
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) } as ConversationQueue;
    const service = new ConversationSubmissionService(conversations, queue, runServices());

    const context = apiIngressContext('api:operator');
    await service.submitThread(
      context.owner.id,
      { version: '1', prompt: 'Retry the same message.', source: context.source },
      {
        idempotencyKey: 'message-1',
        traceId: 'trace-retry',
        provenance: { actor: context.actor, credentialSubject: context.credentialSubject },
      },
      {
        conversationId: apiConversationId(context.owner.id, 'headless-smoke'),
        messageId: 'message-1',
      },
    );

    expect(conversations.getMessage).toHaveBeenCalledWith(
      apiConversationId('api:operator', 'headless-smoke'),
      'message-1',
    );
    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: 'defer' }),
    );
  });

  it('uses different runtime IDs for the same key owned by different callers', () => {
    expect(apiConversationId('api:owner-a', 'shared')).not.toBe(
      apiConversationId('api:owner-b', 'shared'),
    );
  });
});

function runServices() {
  return {
    idFor: vi.fn((_ownerId: string, key: string) => `run-${key}`),
    submit: vi.fn(async (ownerId: string, request: unknown, options: { idempotencyKey?: string }) => ({
      runId: `run-${options.idempotencyKey}`,
      ownerId,
      request,
    })),
  } as unknown as Pick<RunService, 'idFor' | 'submit'> & {
    idFor: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
  };
}
