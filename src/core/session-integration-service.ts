import { createHash } from 'node:crypto';
import { parseRepository } from '../domain/validation.js';
import type { AgentResource, AgentsStore, AgentsClock } from './agents-ports.js';
import type { SessionService } from './session-service.js';
import type { SessionState } from './session-ports.js';
import type { SessionDelivery, SessionIntegrationInput, SessionIntegrationState, SessionIntegrationTarget, ThreadSubscription, IntegrationOccurrence } from '../domain/session-integrations.js';
import { AgentsApiError, parseAgentsContract } from '../domain/agents-api-validation.js';
import { integrationDigest, integrationSessionId, integrationOccurrenceId, threadSubscriptionId, planThreadAdmission, releaseThreadSubscription } from './session-integration-planning.js';
import type { SessionPreparation } from './session-preparation-planning.js';
import { THREAD_RELEASE_TOOL, parseThreadRelease } from './thread-release-tool.js';
import { terminalTurn } from './session-planning.js';

export interface SessionDeliveryPort { deliver(delivery: SessionDelivery): Promise<void> }

/** Durable integration receipts feed the canonical Session outbox. No second execution lifecycle. */
export class SessionIntegrationService {
  public constructor(private readonly options: { store: AgentsStore; sessions: SessionService; delivery: SessionDeliveryPort; clock?: AgentsClock; allowedRepositoryHosts?: string[] }) {}

  public async accept(ownerId: string, bindingId: string, threadKey: string, target: SessionIntegrationTarget, input: SessionIntegrationInput, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = []): Promise<{ sessionId: string }> {
    parseAgentsContract('SessionCreate', { agent_id: target.agentId, environment: target.environment, vault_ids: target.vaultIds ?? [], input: input.text });
    if (input.repository && target.environment.type !== 'openai_hosted') throw new AgentsApiError(400, 'Repository webhooks require a managed environment.', 'invalid_request', 'environment');
    if (input.repository) parseRepository(input.repository, this.options.allowedRepositoryHosts ?? ['github.com', 'gitlab.com']);
    const subscriptionId = threadSubscriptionId(bindingId, threadKey);
    const occurrenceId = integrationOccurrenceId(bindingId, input.id);
    const digest = integrationDigest(input);
    for (let attempt = 0; ; attempt++) {
      const occurrence = await this.options.store.get<IntegrationOccurrence>(ownerId, 'integration_occurrences', occurrenceId);
      if (occurrence) {
        if (occurrence.value.digest !== digest) throw new AgentsApiError(409, 'This provider occurrence was already accepted with different input.', 'idempotency_conflict');
        return { sessionId: occurrence.value.sessionId };
      }
      const subscription = await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', subscriptionId);
      const currentId = subscription?.value.subscribers[0]?.sessionId ?? integrationSessionId(bindingId, threadKey);
      const current = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', currentId);
      if (!subscription && current) {
        await this.rememberOccurrences(bindingId, current);
        const accepted = current.value.inputs.find(receipt => receipt.id === input.id);
        if (accepted) {
          if (accepted.digest !== digest) throw new AgentsApiError(409, 'This provider occurrence was already accepted with different input.', 'idempotency_conflict');
          return { sessionId: current.id };
        }
      }
      const session = await this.options.store.get<SessionState>(ownerId, 'sessions', currentId);
      const preparation = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', currentId);
      const sessionDeleted = session?.value.closing === true || !session && (preparation?.value.created === true || current?.value.inputs.some(entry => Boolean(entry.turnId)) === true);
      const plan = planThreadAdmission({ bindingId, threadKey, ...(subscription ? { subscription: subscription.value } : {}), ...(current ? { integration: current.value } : {}), sessionDeleted, target, occurrence: input });
      const now = this.options.clock?.now() ?? Math.floor(Date.now() / 1000);
      const retained = plan.sessionId === currentId ? current : undefined;
      try {
        await this.options.store.commit([
          { resource: { ownerId, id: subscriptionId, collection: 'thread_subscriptions', createdAt: subscription?.createdAt ?? now, revision: (subscription?.revision ?? 0) + 1, value: plan.subscription }, expectedRevision: subscription?.revision ?? 0 },
          { resource: { ownerId, id: plan.sessionId, collection: 'session_integrations', createdAt: retained?.createdAt ?? now, revision: (retained?.revision ?? 0) + 1, value: plan.integration }, expectedRevision: retained?.revision ?? 0 },
          { resource: { ownerId, id: occurrenceId, collection: 'integration_occurrences', createdAt: now, revision: 1, value: { sessionId: plan.sessionId, epoch: plan.subscription.epoch, digest } }, expectedRevision: 0 },
          ...(plan.supersededSessionId && current ? [{ resource: { ...current, revision: current.revision + 1, value: { ...current.value, supersededBy: plan.sessionId } }, expectedRevision: current.revision }] : []),
          ...writes,
        ]);
        return { sessionId: plan.sessionId };
      } catch (error) { if (!conflict(error) || writes.length > 0 || attempt >= 9) throw error; }
    }
  }

  private async rememberOccurrences(bindingId: string, integration: AgentResource<SessionIntegrationState>): Promise<void> {
    for (const input of integration.value.inputs) {
      const id = integrationOccurrenceId(bindingId, input.id);
      const value = { sessionId: integration.id, epoch: integration.value.epoch ?? 0, digest: input.digest };
      const existing = await this.options.store.get<IntegrationOccurrence>(integration.ownerId, 'integration_occurrences', id);
      if (existing) continue;
      try { await this.options.store.put({ ownerId: integration.ownerId, id, collection: 'integration_occurrences', createdAt: integration.createdAt, revision: 1, value }, 0); }
      catch (error) { if (!conflict(error)) throw error; }
    }
  }

  public async listSubscriptions(ownerId: string, query: { after?: string; limit?: number } = {}) {
    const page = await this.options.store.list<ThreadSubscription>(ownerId, 'thread_subscriptions', query);
    return { object: 'list' as const, data: page.data.map(resource => ({ id: resource.id, ...resource.value })), has_more: page.has_more };
  }

  public async subscription(ownerId: string, id: string) {
    const resource = await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', id);
    if (!resource) throw new AgentsApiError(404, 'Thread subscription not found.', 'resource_not_found');
    return { id: resource.id, ...resource.value };
  }

  public async hasActiveSubscription(ownerId: string, bindingId: string, threadKey: string): Promise<boolean> {
    const subscription = await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', threadSubscriptionId(bindingId, threadKey));
    const active = subscription?.value.subscribers.find(subscriber => subscriber.state === 'active');
    if (!active) return false;
    const session = await this.options.store.get<SessionState>(ownerId, 'sessions', active.sessionId);
    if (session) return !session.value.closing;
    const preparation = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', active.sessionId);
    return preparation?.value.created !== true && preparation?.value.abandoned !== true;
  }

  public async release(ownerId: string, id: string, raw: unknown, sessionId?: string, expectedEpoch?: number): Promise<{ id: string; sessionId: string; released: true }> {
    const { reason } = parseThreadRelease(raw);
    for (let attempt = 0; ; attempt++) {
      const previous = sessionId ? await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', sessionId) : undefined;
      if (previous?.value.threadSubscriptionId === id && previous.value.threadReleased) return { id, sessionId: previous.id, released: true };
      const current = await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', id);
      if (!current) throw new AgentsApiError(404, 'Thread subscription not found.', 'resource_not_found');
      if (expectedEpoch !== undefined && current.value.epoch !== expectedEpoch) throw new AgentsApiError(409, 'The thread subscription has moved to another epoch.', 'thread_subscription_released');
      const subscriber = current.value.subscribers.find(subscriber => sessionId === undefined || subscriber.sessionId === sessionId);
      if (!subscriber) throw new AgentsApiError(409, 'This Session no longer owns the thread subscription.', 'thread_subscription_released');
      const value = releaseThreadSubscription(current.value, subscriber.sessionId, reason);
      if (value === current.value) return { id, sessionId: subscriber.sessionId, released: true };
      const integration = previous ?? await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', subscriber.sessionId);
      try {
        await this.options.store.commit([
          { resource: { ...current, revision: current.revision + 1, value }, expectedRevision: current.revision },
          ...(integration ? [{ resource: { ...integration, revision: integration.revision + 1, value: { ...integration.value, threadReleased: { reason } } }, expectedRevision: integration.revision }] : []),
        ]);
        return { id, sessionId: subscriber.sessionId, released: true };
      } catch (error) { if (!conflict(error) || attempt >= 9) throw error; }
    }
  }

  public async resolveTools(ownerId: string, sessionId: string): Promise<void> {
    const integration = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', sessionId);
    if (!integration?.value.threadSubscriptionId || integration.value.inputs[0]?.source.kind === 'api') return;
    const state = await this.options.store.get<SessionState>(ownerId, 'sessions', sessionId);
    if (!state || state.value.closing) return;
    const session = await this.options.sessions.retrieve(ownerId, sessionId);
    for (const action of session.required_actions) {
      if (action.type !== 'function_call' || action.name !== THREAD_RELEASE_TOOL.name) continue;
      let output: unknown;
      let success = true;
      try { output = await this.release(ownerId, integration.value.threadSubscriptionId, action.arguments, sessionId); }
      catch (error) {
        if (!(error instanceof AgentsApiError) || error.status >= 500 || error.code === 'conflict') throw error;
        success = false; output = { error: { code: error.code, message: error.message } };
      }
      await this.options.sessions.events(ownerId, sessionId, { events: [{ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, output: JSON.stringify(output), success }] }, `thread-release:${integrationDigest([action.turn_id, action.call_id])}`);
    }
  }

  /** The shared FIFO consumer calls this; each step can resume after a lost acknowledgement. */
  public async submitPending(ownerId: string, id: string): Promise<void> {
    const current = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
    if (!current) return;
    for (const [index, input] of current.value.inputs.entries()) {
      if (input.turnId) continue;
      const { target } = current.value;
      if (index === 0) await this.options.sessions.create(ownerId, { agent_id: target.agentId, environment: target.environment, vault_ids: target.vaultIds ?? [], input: input.text, ...(target.runtime ? { metadata: { rat_things_runtime: target.runtime } } : {}) }, id, target.runtimePin);
      else await this.options.sessions.events(ownerId, id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: input.text }] }] }] }, receiptKey(input.id));
      const session = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
      const commands = session?.value.receipts[index === 0 ? 'initial' : integrationDigestString(receiptKey(input.id))]?.commands;
      const turnId = commands?.find((command) => command.type === 'start' || command.type === 'steer')?.turnId;
      if (!turnId) throw new Error('Session input acknowledgement is missing its Turn');
      // Reread so a webhook accepted during execution is retained.
      const latest = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
      if (!latest) return;
      await this.options.store.put({ ...latest, revision: latest.revision + 1, value: { ...latest.value, inputs: latest.value.inputs.map((entry) => entry.id === input.id ? { ...entry, turnId } : entry) } }, latest.revision);
    }
  }

  public async deliverReady(ownerId: string, id: string): Promise<void> {
    const integration = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
    if (!integration) return;
    const session = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!session) return;
    for (const input of integration.value.inputs) {
      if (input.deliveryProcessed) continue;
      const binding = session.value.turns.find(({ turn }) => turn.id === input.turnId);
      if (!binding || !terminalTurn(binding.turn) || !binding.savedItems) continue;
      const { target } = integration.value;
      await this.options.delivery.deliver({ ownerId, sessionId: id, turn: binding.turn, items: binding.savedItems, source: input.source,
        ...(target.destinations ? { destinations: target.destinations } : {}), ...(target.connectionSetId ? { connectionSetId: target.connectionSetId } : {}),
      });
      const current = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
      if (!current) return;
      await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, inputs: current.value.inputs.map((receipt) => receipt.id === input.id ? { ...receipt, deliveryProcessed: true } : receipt) } }, current.revision);
    }
  }
}
function receiptKey(id: string): string { return `integration:${integrationDigest(id)}`; }
// Session event receipts hash the exact header, rather than its JSON representation.
function integrationDigestString(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function conflict(error: unknown): boolean { return error instanceof AgentsApiError && error.code === 'conflict'; }
