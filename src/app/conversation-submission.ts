import { createHash } from 'node:crypto';
import type { ConversationQueue } from '../conversation/types.js';
import { ConversationService } from '../conversation/service.js';
import type { ConversationExecutionPolicy } from '../domain/conversations.js';
import { ValidationError } from '../domain/validation.js';
import type { IngressContext } from '../identity/context.js';
import type { IngressWork } from '../ingress/types.js';

export interface ApiConversationMessageInput {
  conversationKey: string;
  messageId: string;
  prompt: string;
  context: IngressContext & { source: { kind: 'api' } };
  traceId: string;
  executionPolicy?: ConversationExecutionPolicy;
}

export interface ConversationMessageReceipt {
  conversationId: string;
  messageId: string;
  status: 'appended' | 'duplicate';
}

export class ConversationSubmissionService {
  public constructor(
    private readonly conversations: ConversationService,
    private readonly queue: ConversationQueue,
  ) {}

  public async submit(work: IngressWork): Promise<{ conversationId: string; messageId: string }> {
    const source = work.context.source;
    if (source.kind !== 'teams') throw new Error('conversation submission currently supports Teams');
    const conversationId = [
      'teams',
      source.tenantId ?? 'unknown',
      source.senderId ?? 'unknown',
      source.conversationId,
    ].join(':');
    const messageId = source.activityId;
    const current = await this.conversations.get(conversationId);
    const delivery = current?.activeTurnId ? 'interrupt' : 'defer';
    const receipt = await this.conversations.appendMessage({
      conversationId,
      ownerId: work.context.owner.id,
      messageId,
      delivery,
      content: {
        text: work.request.prompt,
        metadata: { provider: 'teams', traceId: work.submit.traceId ?? messageId },
      },
      source,
      destination: { kind: 'source' },
      actor: work.context.actor,
      credentialSubject: work.context.credentialSubject,
    });
    await this.queue.enqueue({
      version: '1',
      conversationId,
      traceId: work.submit.traceId ?? `teams:${hash(messageId).slice(0, 24)}`,
    });
    return { conversationId, messageId: receipt.message.messageId };
  }

  /**
   * Appends an IAM-authenticated CLI/API prompt to the same durable mailbox used by providers.
   * The caller-visible key is owner-scoped before it becomes a runtime conversation ID.
   */
  public async submitApi(input: ApiConversationMessageInput): Promise<ConversationMessageReceipt> {
    const conversationId = apiConversationId(input.context.owner.id, input.conversationKey);
    const current = await this.conversations.get(conversationId);
    const receipt = await this.conversations.appendMessage({
      conversationId,
      ownerId: input.context.owner.id,
      messageId: input.messageId,
      delivery: current?.activeTurnId ? 'interrupt' : 'defer',
      content: { text: input.prompt },
      source: input.context.source,
      destination: { kind: 'none' },
      actor: input.context.actor,
      credentialSubject: input.context.credentialSubject,
      ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
    });
    await this.queue.enqueue({
      version: '1',
      conversationId,
      traceId: input.traceId,
    });
    return {
      conversationId: input.conversationKey,
      messageId: receipt.message.messageId,
      status: receipt.status,
    };
  }
}

export function apiConversationId(ownerId: string, conversationKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationKey)) {
    throw new ValidationError('conversation ID must be 1-128 safe ASCII characters');
  }
  return `api:${hash(ownerId).slice(0, 32)}:${conversationKey}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
