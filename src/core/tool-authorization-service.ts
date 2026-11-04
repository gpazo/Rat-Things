import type { AgentResource, AgentsStore } from './agents-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { InspectionListParams, InspectionPage } from '../domain/configuration-history.js';
import { canonicalJson } from '../domain/json.js';
import type { ToolAuthorizationDecision, ToolAuthorizationReceipt, ToolDispatchOutcome } from '../domain/tool-authorization.js';

export const MAX_TOOL_AUTHORIZATIONS = 32;
const decisionsCollection = (sessionId: string) => `tool_authorizations/${sessionId}`;
const outcomesCollection = (sessionId: string) => `tool_authorization_outcomes/${sessionId}`;

/** Decisions and observations are independent, immutable owner-scoped records. */
export class ToolAuthorizationService {
  public constructor(private readonly store: AgentsStore) {}

  public async record(ownerId: string, decisions: ToolAuthorizationDecision[]): Promise<void> {
    bounded(decisions.map(decision => decision.id));
    if (new Set(decisions.map(decision => decision.identity.sessionId)).size !== 1) throw new Error('Authorization batch must belong to one Session');
    await this.retain(decisions.map(value => ({ ownerId, collection: decisionsCollection(value.identity.sessionId), id: value.id,
      createdAt: value.at, revision: 1, value: structuredClone(value) })));
  }

  public async recordOutcome(ownerId: string, sessionId: string, decisionIds: string[], outcome: ToolDispatchOutcome): Promise<void> {
    bounded(decisionIds);
    // Outcome writes cannot invent receipts or move them across Sessions/owners.
    await Promise.all(decisionIds.map(id => this.required(ownerId, sessionId, id)));
    await this.retain(decisionIds.map(id => ({ ownerId, collection: outcomesCollection(sessionId), id,
      createdAt: outcome.at, revision: 1, value: structuredClone(outcome) })));
  }

  public async list(ownerId: string, sessionId: string, raw?: unknown): Promise<InspectionPage<ToolAuthorizationReceipt>> {
    const page = await this.store.list<ToolAuthorizationDecision>(ownerId, decisionsCollection(sessionId), inspectionQuery(raw));
    const data = await Promise.all(page.data.map(({ value }) => this.receipt(ownerId, sessionId, value)));
    return { object: 'list', data, has_more: page.has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  }

  public async retrieve(ownerId: string, sessionId: string, id: string): Promise<ToolAuthorizationReceipt> {
    return this.receipt(ownerId, sessionId, (await this.required(ownerId, sessionId, id)).value);
  }

  private async required(ownerId: string, sessionId: string, id: string) {
    const row = await this.store.get<ToolAuthorizationDecision>(ownerId, decisionsCollection(sessionId), id);
    if (!row) throw new AgentsApiError(404, 'Tool authorization not found.', 'not_found');
    return row;
  }

  private async receipt(ownerId: string, sessionId: string, decision: ToolAuthorizationDecision): Promise<ToolAuthorizationReceipt> {
    const observed = await this.store.get<ToolDispatchOutcome>(ownerId, outcomesCollection(sessionId), decision.id);
    return { ...decision, outcome: observed?.value ?? { kind: 'unknown', reason: 'no_observation' } };
  }

  private async retain(resources: AgentResource<unknown>[]): Promise<void> {
    try {
      await this.store.commit(resources.map(resource => ({ resource, expectedRevision: 0 })));
    } catch {
      // A lost acknowledgement may follow a successful transaction. Read back
      // the complete bounded plan; never repeat a potentially completed effect.
      const retained = await Promise.all(resources.map(resource => this.store.get(resource.ownerId, resource.collection, resource.id)));
      if (!retained.every((row, index) => row?.revision === 1 && canonicalJson(row.value) === canonicalJson(resources[index]!.value))) {
        throw new Error('Tool authorization persistence failed');
      }
    }
  }
}

function bounded(ids: string[]): void {
  if (!ids.length || ids.length > MAX_TOOL_AUTHORIZATIONS || new Set(ids).size !== ids.length) throw new Error('Invalid tool authorization batch');
}

function inspectionQuery(raw: unknown): InspectionListParams {
  if (raw === undefined) return { limit: 20, order: 'desc' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentsApiError(400, 'Invalid pagination.', 'invalid_request');
  const value = raw as Record<string, unknown>;
  const limit = value.limit === undefined ? 20 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || value.order !== undefined && value.order !== 'asc' && value.order !== 'desc'
    || value.after !== undefined && (typeof value.after !== 'string' || !value.after.length || value.after.length > 256)
    || Object.keys(value).some(key => !['limit', 'order', 'after'].includes(key))) throw new AgentsApiError(400, 'Invalid pagination.', 'invalid_request');
  return { limit, order: value.order as 'asc' | 'desc' | undefined ?? 'desc', ...(typeof value.after === 'string' ? { after: value.after } : {}) };
}
