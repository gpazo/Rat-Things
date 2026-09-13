import { createHash } from 'node:crypto';
import { parseRepository } from '../domain/validation.js';
import type { AgentsStore, AgentsClock } from './agents-ports.js';
import type { SessionService } from './session-service.js';
import type { SessionState } from './session-ports.js';
import type { SessionDelivery, SessionIntegrationInput, SessionIntegrationState, SessionIntegrationTarget } from '../domain/session-integrations.js';
import { AgentsApiError, parseAgentsContract } from '../domain/agents-api-validation.js';
import { acceptIntegrationInput, integrationDigest, integrationSessionId } from './session-integration-planning.js';
import { terminalTurn } from './session-planning.js';

export interface SessionDeliveryPort { deliver(delivery: SessionDelivery): Promise<void> }

/** Durable integration receipts feed the canonical Session outbox. No second execution lifecycle. */
export class SessionIntegrationService {
  public constructor(private readonly options: { store: AgentsStore; sessions: SessionService; delivery: SessionDeliveryPort; clock?: AgentsClock; allowedRepositoryHosts?: string[] }) {}

  public async accept(ownerId: string, bindingId: string, threadId: string, target: SessionIntegrationTarget, input: SessionIntegrationInput): Promise<{ sessionId: string }> {
    parseAgentsContract('SessionCreate', { agent_id: target.agentId, environment: target.environment, vault_ids: target.vaultIds ?? [], input: input.text });
    if (input.repository && target.environment.type !== 'openai_hosted') throw new AgentsApiError(400, 'Repository webhooks require a managed environment.', 'invalid_request', 'environment');
    if (input.repository) parseRepository(input.repository, this.options.allowedRepositoryHosts ?? ['github.com', 'gitlab.com']);
    const id = integrationSessionId(bindingId, threadId);
    for (let attempt = 0; ; attempt++) {
      const current = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
      const value = acceptIntegrationInput(current?.value, target, input);
      if (value === current?.value) return { sessionId: id };
      try {
        await this.options.store.put({ ownerId, id, collection: 'session_integrations', createdAt: current?.createdAt ?? this.options.clock?.now() ?? Math.floor(Date.now() / 1000), revision: (current?.revision ?? 0) + 1, value }, current?.revision ?? 0);
        return { sessionId: id };
      } catch (error) { if (!conflict(error) || attempt >= 9) throw error; }
    }
  }

  /** The shared FIFO consumer calls this; each step can resume after a lost acknowledgement. */
  public async submitPending(ownerId: string, id: string): Promise<void> {
    const current = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
    if (!current) return;
    for (const [index, input] of current.value.inputs.entries()) {
      if (input.turnId) continue;
      const { target } = current.value;
      if (index === 0) await this.options.sessions.create(ownerId, { agent_id: target.agentId, environment: target.environment, vault_ids: target.vaultIds ?? [], input: input.text }, id);
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
