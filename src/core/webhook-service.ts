import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AgentResource, AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';
import type { WebhookSecrets } from '../credentials/webhooks.js';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { webhookEndpointInput, webhookRetry, type StoredWebhookEndpoint, type WebhookDelivery } from '../domain/session-webhooks.js';
import type { SessionEventBatch } from './session-event-store.js';

export interface WebhookTransport { post(url: string, body: string, headers: Record<string, string>): Promise<number> }
export interface WebhookAttempt { retryAfterSeconds?: number }

export class WebhookService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;
  public constructor(private readonly options: { store: AgentsStore; secrets: WebhookSecrets; transport: WebhookTransport; clock?: AgentsClock; ids?: AgentsIds; signingSecret?: () => string }) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }
  public async create(ownerId: string, raw: unknown) {
    const input = webhookEndpointInput(raw);
    const registry = await this.options.store.get<string[]>(ownerId, 'webhook_registry', 'endpoints');
    if ((registry?.value.length ?? 0) >= 100) throw new AgentsApiError(409, 'At most 100 webhook endpoints can be configured.', 'limit_exceeded');
    const id = this.ids.next('whep');
    const now = this.clock.now();
    const secret = this.newSecret();
    const secretReference = await this.options.secrets.create(ownerId, id, secret);
    const endpoint = { ...input, id, object: 'webhook.endpoint' as const, created_at: now };
    // Preserve the secret on an ambiguous commit. Deleting it here could break a
    // successfully committed endpoint; a later explicit rotation recovers access.
    await this.options.store.commit([
      { resource: { id, ownerId, collection: 'webhook_endpoints', createdAt: now, revision: 1, value: { endpoint, secretReference } }, expectedRevision: 0 },
      { resource: { id: 'endpoints', ownerId, collection: 'webhook_registry', createdAt: registry?.createdAt ?? now, revision: (registry?.revision ?? 0) + 1, value: [...registry?.value ?? [], id] }, expectedRevision: registry?.revision ?? 0 },
    ]);
    return { ...endpoint, signing_secret: secret };
  }
  public async retrieve(owner: string, id: string) { return (await this.required(owner, id)).value.endpoint; }
  public async list(owner: string) {
    const page = await this.options.store.list<StoredWebhookEndpoint>(owner, 'webhook_endpoints', { limit: 100, order: 'asc' });
    return { object: 'list' as const, data: page.data.map(({ value }) => value.endpoint), has_more: false };
  }
  public async update(owner: string, id: string, raw: unknown) {
    const resource = await this.required(owner, id);
    const endpoint = { ...resource.value.endpoint, ...webhookEndpointInput(raw, resource.value.endpoint) };
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, endpoint } }, resource.revision);
    return endpoint;
  }
  public async rotate(owner: string, id: string) {
    const resource = await this.required(owner, id);
    const signing_secret = this.newSecret();
    const secretReference = await this.options.secrets.create(owner, id, signing_secret);
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, secretReference } }, resource.revision);
    await this.options.secrets.revoke(resource.value.secretReference);
    return { ...resource.value.endpoint, signing_secret };
  }
  public async delete(owner: string, id: string) {
    const resource = await this.required(owner, id);
    for (let attempt = 0; attempt < 10; attempt++) {
      const registry = await this.options.store.get<string[]>(owner, 'webhook_registry', 'endpoints');
      const writes = registry ? [{ resource: { ...registry, revision: registry.revision + 1, value: registry.value.filter((entry) => entry !== id) }, expectedRevision: registry.revision }] : [];
      try { await this.options.store.delete(resource, writes); break; }
      catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error; }
    }
    // Endpoint absence disables all pending delivery before credential access.
    await this.options.secrets.revoke(resource.value.secretReference);
    return { id, object: 'webhook.endpoint.deleted' as const, deleted: true };
  }

  /** Each event/endpoint pair has an immutable identity; a lost fanout acknowledgement is safe to retry. */
  public async fanout(ownerId: string, batchId: string): Promise<void> {
    const batch = await this.options.store.get<SessionEventBatch>(ownerId, 'session_event_batches', batchId);
    if (!batch) return;
    for (const endpointId of batch.value.endpointIds) {
      const endpoint = await this.options.store.get<StoredWebhookEndpoint>(ownerId, 'webhook_endpoints', endpointId);
      if (!endpoint?.value.endpoint.enabled) continue;
      for (const event of batch.value.webhooks) {
        if (!endpoint.value.endpoint.events.includes(event.type)) continue;
        const id = `wh_${createHash('sha256').update(JSON.stringify([ownerId, endpointId, event.id])).digest('hex')}`;
        if (await this.options.store.get(ownerId, 'webhook_deliveries', id)) continue;
        const value: WebhookDelivery = { endpointId, event, webhookId: id, status: 'pending', attempts: 0, nextAttemptAt: event.created_at, deadline: event.created_at + 72 * 3600 };
        try { await this.options.store.put({ id, ownerId, collection: 'webhook_deliveries', createdAt: event.created_at, revision: 1, expiresAt: event.created_at + 7 * 86400, value }, 0); }
        catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict') throw error; }
      }
    }
  }

  public async deliver(ownerId: string, id: string): Promise<WebhookAttempt> {
    const resource = await this.options.store.get<WebhookDelivery>(ownerId, 'webhook_deliveries', id);
    if (!resource || ['delivered', 'failed', 'disabled'].includes(resource.value.status)) return {};
    const now = this.clock.now();
    if (now >= resource.value.deadline) { await this.save(resource, { ...resource.value, status: 'failed' }); return {}; }
    const readyAt = Math.max(resource.value.nextAttemptAt, resource.value.leaseUntil ?? 0);
    if (readyAt > now) return { retryAfterSeconds: readyAt - now };
    const endpoint = await this.options.store.get<StoredWebhookEndpoint>(ownerId, 'webhook_endpoints', resource.value.endpointId);
    if (!endpoint?.value.endpoint.enabled || !endpoint.value.endpoint.events.includes(resource.value.event.type)) {
      await this.save(resource, { ...resource.value, status: 'disabled' }); return {};
    }
    const claimed = await this.save(resource, { ...resource.value, status: 'delivering', leaseUntil: now + 60, attempts: resource.value.attempts + 1 });
    let status: number | undefined;
    try {
      const secret = await this.options.secrets.read(endpoint.value.secretReference);
      const payload = JSON.stringify(resource.value.event);
      status = await this.options.transport.post(endpoint.value.endpoint.url, payload, webhookHeaders(resource.value.webhookId, now, payload, secret));
    } catch { /* Network and credential failures retry without retaining secrets or response bodies. */ }
    const finishedAt = this.clock.now();
    const next = status !== undefined && status >= 200 && status < 300 ? { status: 'delivered' as const, nextAttemptAt: finishedAt }
      : webhookRetry(claimed.value.attempts, finishedAt, claimed.value.deadline);
    await this.save(claimed, { ...claimed.value, ...next, leaseUntil: 0, ...(status !== undefined ? { lastStatus: status } : {}) });
    return next.status === 'pending' ? { retryAfterSeconds: Math.max(1, next.nextAttemptAt - finishedAt) } : {};
  }
  private required(owner: string, id: string) { return this.options.store.get<StoredWebhookEndpoint>(owner, 'webhook_endpoints', id).then((value) => value ?? resourceNotFound()); }
  private async save(resource: AgentResource<WebhookDelivery>, value: WebhookDelivery) {
    const updated = { ...resource, revision: resource.revision + 1, value };
    await this.options.store.put(updated, resource.revision);
    return updated;
  }
  private newSecret() { return this.options.signingSecret?.() ?? `whsec_${randomBytes(32).toString('base64')}`; }
}

/** Standard Webhooks signs the exact bytes, including a stable delivery ID and per-attempt timestamp. */
export function webhookHeaders(id: string, now: number, payload: string, secret: string): Record<string, string> {
  if (!secret.startsWith('whsec_')) throw new Error('Invalid webhook signing secret');
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${now}.${payload}`).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': `v1,${signature}`, 'user-agent': 'RatThings/1.0' };
}
