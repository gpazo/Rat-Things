import { describe, expect, it, vi } from 'vitest';
import {
  apiConversationId,
  ConversationSubmissionService,
} from '../../src/app/conversation-submission.js';
import type { ConversationService } from '../../src/conversation/service.js';
import type { ConversationQueue } from '../../src/conversation/types.js';
import { apiIngressContext } from '../../src/identity/context.js';

describe('API conversation submission', () => {
  it('owner-scopes the key and appends a provider-neutral durable message', async () => {
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
    const service = new ConversationSubmissionService(conversations, queue);
    const context = apiIngressContext('api:arn:aws:iam::123456789012:user/operator');

    await expect(service.submitApi({
      conversationKey: 'headless-smoke',
      messageId: 'message-1',
      prompt: 'Use a shell command and report its output.',
      context,
      traceId: 'trace-1',
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
    })).resolves.toEqual({
      conversationId: 'headless-smoke',
      messageId: 'message-1',
      status: 'appended',
    });

    const runtimeId = apiConversationId(context.owner.id, 'headless-smoke');
    expect(runtimeId).toMatch(/^api:[a-f0-9]{32}:headless-smoke$/);
    expect(conversations.appendMessage).toHaveBeenCalledWith({
      conversationId: runtimeId,
      ownerId: context.owner.id,
      messageId: 'message-1',
      delivery: 'defer',
      content: { text: 'Use a shell command and report its output.' },
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
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      version: '1',
      conversationId: runtimeId,
      traceId: 'trace-1',
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
    const service = new ConversationSubmissionService(conversations, queue);

    await service.submitApi({
      conversationKey: 'headless-smoke',
      messageId: 'message-2',
      prompt: 'Follow up now.',
      context: apiIngressContext('api:operator'),
      traceId: 'trace-2',
    });

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
    const service = new ConversationSubmissionService(conversations, queue);

    await service.submitApi({
      conversationKey: 'headless-smoke',
      messageId: 'message-1',
      prompt: 'Retry the same message.',
      context: apiIngressContext('api:operator'),
      traceId: 'trace-retry',
    });

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
