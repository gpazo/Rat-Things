import { createHash } from 'node:crypto';
import type { ConversationQueue } from '../conversation/types.js';
import { ConversationService } from '../conversation/service.js';
import type { IngressWork } from '../ingress/types.js';

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
    await this.conversations.appendMessage({
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
    return { conversationId, messageId };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
