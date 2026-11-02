import { createHash } from 'node:crypto';
import type { AgentsStore } from './agents-ports.js';
import type { SessionDeliveryPort } from './session-integration-service.js';
import type { WatchdogFinding } from '../domain/watchdog.js';
import type { SessionIntegrationState } from '../domain/session-integrations.js';
import type { SessionEventBatch } from './session-event-store.js';
import type { StoredWebhookEndpoint, WebhookDelivery } from '../domain/session-webhooks.js';
import type { WebhookService } from './webhook-service.js';
import type { RunDestination } from '../domain/contracts.js';

export class WatchdogReporting {
  public constructor(private readonly options: { store: AgentsStore; delivery: SessionDeliveryPort; webhooks: Pick<WebhookService, 'fanout' | 'deliver'>; operatorDestinations: RunDestination[] }) {}
  public async report(id: string, finding: WatchdogFinding): Promise<void> {
    const { candidate, judge } = finding;
    const { ownerId } = candidate;
    const sessionId = candidate.sessionId ?? id;
    const text = [`Watchdog ${candidate.reason}.`, `Subject ${candidate.subjectId}.`, `Session ${candidate.sessionId ?? 'deployment'}; Turn ${candidate.turnId ?? 'none'}.`,
      `Retry ${finding.retry}; cancellation ${finding.cancel}.`,
      judge.status === 'completed' ? `Assessment ${judge.verdict.verdict} (${judge.verdict.confidence}). ${judge.verdict.evidence.join(' ')}` : `Assessment ${judge.status}.`,
      ...(judge.status !== 'skipped' && judge.sessionId ? [`Judge Session ${judge.sessionId}.`] : []), `Finding ${id}.`,
    ].join('\n');
    const integration = candidate.sessionId ? await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', candidate.sessionId) : undefined;
    const source = integration?.value.inputs.at(-1)?.source ?? { kind: 'api' as const };
    const target = integration?.value.target;
    let deliveryFailed = false;
    try { await this.options.delivery.deliver({ ownerId, sessionId,
      turn: { id, object: 'agent.session.turn', session_id: sessionId, agent_id: 'watchdog', subagent_id: null, status: 'completed', created_at: finding.observedAt, started_at: finding.observedAt, completed_at: finding.observedAt, error: null, usage: null },
      items: [{ id: `${id}_message`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', turn_id: id, content: [{ type: 'output_text', text }] }], source,
      ...(target ? target.destinations ? { destinations: target.destinations } : {} : { destinations: this.options.operatorDestinations }),
      ...(target?.connectionSetId ? { connectionSetId: target.connectionSetId } : {}),
    }); } catch { deliveryFailed = true; }
    if (!candidate.sessionId) {
      if (deliveryFailed) throw new Error('Watchdog destination delivery is pending');
      return;
    }
    let batch = await this.options.store.get<SessionEventBatch>(ownerId, 'session_event_batches', id);
    if (!batch) {
      const endpoints = await this.options.store.list<StoredWebhookEndpoint>(ownerId, 'webhook_endpoints', { limit: 100 });
      batch = { ownerId, id, collection: 'session_event_batches', createdAt: finding.observedAt, revision: 1, expiresAt: finding.observedAt + 4 * 86400, value: {
        sessionId, events: [], webhooks: [{ id: `evt_${id}`, object: 'event', type: 'agent.session.watchdog', created_at: finding.observedAt, data: { id: sessionId, watchdog: { finding_id: id, reason: candidate.reason, judge_session_id: judge.status === 'skipped' ? null : judge.sessionId ?? null, verdict: judge.status === 'completed' ? judge.verdict.verdict : null } } }],
        endpointIds: endpoints.data.filter(entry => entry.value.endpoint.enabled && entry.value.endpoint.events.includes('agent.session.watchdog')).map(entry => entry.id),
      } };
      await this.options.store.put(batch, 0);
    }
    await this.options.webhooks.fanout(ownerId, id);
    for (const endpointId of batch.value.endpointIds) for (const event of batch.value.webhooks) {
      const deliveryId = `wh_${createHash('sha256').update(JSON.stringify([ownerId, endpointId, event.id])).digest('hex')}`;
      const attempt = await this.options.webhooks.deliver(ownerId, deliveryId);
      const delivery = await this.options.store.get<WebhookDelivery>(ownerId, 'webhook_deliveries', deliveryId);
      if (attempt.retryAfterSeconds || delivery?.value.status === 'pending' || delivery?.value.status === 'delivering') throw new Error('Watchdog webhook delivery is pending');
    }
    if (deliveryFailed) throw new Error('Watchdog destination delivery is pending');
  }
}
