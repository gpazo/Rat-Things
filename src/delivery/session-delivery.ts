import { redactText, secretRedactionPatterns } from '../domain/output-redaction.js';
import { emitMetric } from '../core/metrics.js';
import type { SessionDelivery } from '../domain/session-integrations.js';
import type { SessionDeliveryPort } from '../core/session-integration-service.js';
import type { DeliveryService } from './service.js';

export class SessionDeliveryService implements SessionDeliveryPort {
  public constructor(private readonly delivery: Pick<DeliveryService, 'deliver'>, private readonly secrets?: (ownerId: string, sessionId: string) => Promise<readonly string[]>) {}
  public async deliver(input: SessionDelivery): Promise<void> {
    const messages = input.items.flatMap((item) => item.type === 'message' && item.role === 'assistant' && item.status === 'completed' && item.phase !== 'commentary' ? item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : []) : []);
    if (input.silentIfEmpty && input.turn.status === 'completed' && !messages.join('').trim()) return;
    const body = input.turn.status === 'cancelled' ? `Turn ${input.turn.id} was cancelled.` : input.turn.status === 'failed' ? `Turn ${input.turn.id} failed: ${input.turn.error?.message ?? 'unknown error'}` : messages.join('\n\n') || 'Turn completed.';
    const patterns = secretRedactionPatterns((await this.secrets?.(input.ownerId, input.sessionId) ?? []).map(secret => ({ secret, replacement: '[REDACTED]' })));
    const redacted = redactText(body, patterns);
    if (redacted.count) emitMetric('delivery', 'OutputRedactions', redacted.count, 'Count');
    await this.delivery.deliver({
      execution: { id: input.turn.id, sessionId: input.sessionId, status: input.turn.status, label: 'Turn', credentialOwnerId: input.ownerId },
      request: { source: input.source, ...(input.destinations ? { destinations: input.destinations } : {}), ...(input.connectionSetId ? { integrations: { connectionSet: input.connectionSetId } } : {}) }, body: redacted.value,
    });
  }
}
