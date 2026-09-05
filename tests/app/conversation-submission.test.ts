import { describe, expect, it, vi } from 'vitest';
import {
  apiConversationId,
  ConversationSubmissionService,
} from '../../src/app/conversation-submission.js';
import type { ConversationService } from '../../src/conversation/service.js';
import type { ConversationQueue } from '../../src/conversation/types.js';
import { ConversationConflictError } from '../../src/conversation/types.js';
import type { RunService } from '../../src/core/run-service.js';
import { apiIngressContext } from '../../src/identity/context.js';
import { artifactIdForPath } from '../../src/domain/artifacts.js';
import { createHash } from 'node:crypto';

describe('threaded Run submission', () => {
  it('appends thread state while returning the public Run immediately', async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue(undefined),
      getMessage: vi.fn().mockResolvedValue(undefined),
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

  it('binds durable attachment and reply context to the Run and mailbox message', async () => {
    const path = 'uploads/abc123/notes.txt';
    const bytes = Buffer.from('attached evidence');
    const file = {
      id: artifactIdForPath(path),
      path,
      mediaType: 'text/plain',
      bytes: bytes.byteLength,
      createdAt: '2026-08-25T10:00:00.000Z',
      sourceRunId: 'run-message-upload',
      file: { bucket: 'private-bucket', key: 'upload', sha256: createHash('sha256').update(bytes).digest('hex') },
    };
    const manifest = { bucket: 'private-bucket', key: 'manifest.json', sha256: 'a'.repeat(64) };
    const conversations = {
      get: vi.fn().mockResolvedValue(undefined),
      getMessage: vi.fn().mockResolvedValue(undefined),
      prepareAttachments: vi.fn().mockResolvedValue({ files: [file], manifest }),
      appendMessage: vi.fn().mockImplementation(async (input) => ({
        status: 'appended',
        conversation: {},
        message: { messageId: input.messageId },
      })),
    } as unknown as ConversationService;
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) } as ConversationQueue;
    const runs = runServices();
    const service = new ConversationSubmissionService(conversations, queue, runs);
    const context = apiIngressContext('api:operator');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    await service.submitThread(
      context.owner.id,
      { version: '1', prompt: 'Review the attached notes.', source: context.source },
      {
        idempotencyKey: 'message-upload',
        provenance: { actor: context.actor, credentialSubject: context.credentialSubject },
      },
      {
        conversationId: apiConversationId(context.owner.id, 'upload-thread'),
        messageId: 'message-upload',
        replyToMessageId: 'assistant-prior',
        attachments: [{ name: 'notes.txt', mediaType: 'text/plain', bytes, sha256 }],
      },
    );

    expect(conversations.prepareAttachments).toHaveBeenCalledWith(expect.objectContaining({
      sourceRunId: 'run-message-upload',
      messageId: 'message-upload',
    }));
    expect(runs.submit).toHaveBeenCalledWith(
      context.owner.id,
      expect.anything(),
      expect.objectContaining({
        conversation: expect.objectContaining({
          attachmentManifest: manifest,
          attachmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          replyToMessageId: 'assistant-prior',
        }),
      }),
    );
    expect(conversations.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        attachments: [file],
        replyToMessageId: 'assistant-prior',
      }),
    }));
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

  it('cancels a reserved Run when the fixed conversation envelope rejects it', async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue(undefined),
      getMessage: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockRejectedValue(
        new ConversationConflictError('conversation execution policy cannot change'),
      ),
    } as unknown as ConversationService;
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) } as ConversationQueue;
    const runs = runServices();
    const service = new ConversationSubmissionService(conversations, queue, runs);
    const context = apiIngressContext('api:operator');

    await expect(service.submitThread(
      context.owner.id,
      { version: '1', prompt: 'Widen this thread.', source: context.source },
      {
        idempotencyKey: 'message-rejected',
        provenance: { actor: context.actor, credentialSubject: context.credentialSubject },
      },
      {
        conversationId: apiConversationId(context.owner.id, 'fixed-envelope'),
        messageId: 'message-rejected',
      },
    )).rejects.toThrow('conversation execution policy cannot change');

    expect(runs.cancel).toHaveBeenCalledWith(context.owner.id, 'run-message-rejected');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('replays an accepted legacy message across HTTP traces without appending or cancelling it', async () => {
    const accepted = {messageId: 'message-1', runId: 'run-message-1', delivery: 'interrupt'};
    const conversations = {
      get: vi.fn().mockResolvedValue({status: 'idle'}),
      getMessage: vi.fn().mockResolvedValue(accepted), appendMessage: vi.fn(),
    } as unknown as ConversationService;
    const runs = runServices();
    runs.submit.mockResolvedValue({runId: 'run-message-1', status: 'succeeded'});
    const queue = {enqueue: vi.fn()} as ConversationQueue;
    const service = new ConversationSubmissionService(conversations, queue, runs);
    const context = apiIngressContext('api:operator');
    for (const traceId of ['first-attempt', 'second-attempt']) {
      await expect(service.submitThread(context.owner.id,
        {version: '1', prompt: 'Same input', source: context.source},
        {idempotencyKey: 'message-1', traceId, provenance: {actor: context.actor, credentialSubject: context.credentialSubject}},
        {conversationId: 'conversation-1', messageId: 'message-1'},
      )).resolves.toMatchObject({runId: 'run-message-1'});
    }
    expect(runs.submit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({conversation: expect.objectContaining({delivery: 'interrupt'})}));
    expect(conversations.appendMessage).not.toHaveBeenCalled();
    expect(runs.cancel).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    runs.submit.mockRejectedValue(new Error('the idempotency key was already used with a different request'));
    await expect(service.submitThread(context.owner.id,
      {version: '1', prompt: 'Changed input', source: context.source},
      {idempotencyKey: 'message-1', provenance: {actor: context.actor, credentialSubject: context.credentialSubject}},
      {conversationId: 'conversation-1', messageId: 'message-1'},
    )).rejects.toThrow('different request');
    expect(runs.cancel).not.toHaveBeenCalled();
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
    cancel: vi.fn(),
  } as unknown as Pick<RunService, 'idFor' | 'submit' | 'cancel'> & {
    idFor: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}
