import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import { canonicalJson, sha256Hex } from '../domain/json.js';
import {
  applySessionPlanUpdate,
  emptySessionPlan,
  parseSessionPlanUpdate,
  type SessionPlan,
  type SessionPlanReceiptSource,
  type SessionPlanResultLink,
  type SessionPlanRevision,
} from '../domain/session-plan.js';
import type { AgentsClock, AgentsStore } from './agents-ports.js';

const PLAN_COLLECTION = 'session_plans';
const REVISION_COLLECTION = 'session_plan_revisions';
const CALL_COLLECTION = 'session_plan_calls';
const MAX_PLAN_HISTORY_PAGE = 50;
const PLAN_CALL_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export interface SessionPlanAvailableResults {
  artifacts: Array<{ kind: 'artifact'; artifact_id: string; version_sha256: string; turn_id: string }>;
  activity: Array<{ kind: 'activity'; turn_id: string; item_id: string }>;
}

export interface SessionPlanToolOutput {
  plan?: SessionPlan;
  available_result_links?: SessionPlanAvailableResults;
  error?: { code: string; message: string; current_plan?: SessionPlan };
}

interface SessionPlanCall {
  digest: string;
  output: SessionPlanToolOutput;
}

/** Durable Plan state and the idempotent tool-command boundary. */
export class SessionPlanService {
  public constructor(private readonly store: AgentsStore, private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1_000) }) {}

  public async head(ownerId: string, sessionId: string): Promise<SessionPlan> {
    return (await this.store.get<SessionPlan>(ownerId, PLAN_COLLECTION, sessionId))?.value ?? emptySessionPlan();
  }

  public async history(ownerId: string, sessionId: string, after = 0, limit = 20) {
    if (!Number.isSafeInteger(after) || after < 0) invalid('after must be a non-negative Plan revision.', 'after');
    if (!Number.isSafeInteger(limit) || limit < 1) invalid('limit must be a positive integer.', 'limit');
    const count = Math.min(limit, MAX_PLAN_HISTORY_PAGE);
    const head = await this.head(ownerId, sessionId);
    const end = Math.min(head.revision, after + count);
    const revisions: SessionPlanRevision[] = [];
    for (let revision = after + 1; revision <= end; revision++) {
      const saved = await this.store.get<SessionPlanRevision>(ownerId, REVISION_COLLECTION, revisionId(sessionId, revision));
      if (!saved) throw new AgentsApiError(409, 'Plan history is incomplete. Refresh the current Plan before continuing.', 'plan_history_incomplete');
      revisions.push(saved.value);
    }
    return { session_id: sessionId, head_revision: head.revision, revisions, next_after: end < head.revision ? end : null };
  }

  /**
   * Apply a host-observed Plan tool call. The observed source revisions fence
   * both the active Session and its required-action snapshot at commit time.
   */
  public async resolveCall(input: {
    ownerId: string;
    sessionId: string;
    turnId: string;
    callId: string;
    agentId: string;
    rawArguments: unknown;
    sessionRevision: number;
    observationRevision: number;
    sources: readonly SessionPlanReceiptSource[];
    available: SessionPlanAvailableResults;
    capturedOutputs?: readonly { path: string; artifact_id: string; version_sha256: string }[];
    validArtifactVersions: ReadonlySet<string>;
    validActivityItems: ReadonlySet<string>;
  }): Promise<SessionPlanToolOutput> {
    const digest = sha256Hex(canonicalJson(input.rawArguments));
    const id = callResourceId(input.sessionId, input.turnId, input.callId);
    const existing = await this.store.get<SessionPlanCall>(input.ownerId, CALL_COLLECTION, id);
    if (existing) return replay(existing.value, digest);

    const headResource = await this.store.get<SessionPlan>(input.ownerId, PLAN_COLLECTION, input.sessionId);
    const current = headResource?.value ?? emptySessionPlan();
    let plan: SessionPlan | undefined;
    let output: SessionPlanToolOutput;
    try {
      const update = parseSessionPlanUpdate(input.rawArguments);
      const candidate = applySessionPlanUpdate(update, {
        current,
        sources: input.sources,
        agentId: input.agentId,
        turnId: input.turnId,
        updatedAt: this.clock.now(),
        ...(input.capturedOutputs ? { capturedOutputs: input.capturedOutputs } : {}),
      });
      const capturedVersions = new Set(input.validArtifactVersions);
      for (const output of input.capturedOutputs ?? []) capturedVersions.add(`${output.artifact_id}:${output.version_sha256}`);
      for (const item of candidate.items) for (const link of item.result_links) validateResultLink(link, { ...input, validArtifactVersions: capturedVersions });
      plan = candidate;
      output = { plan, available_result_links: boundedAvailable(input.available) };
    } catch (error) {
      if (!(error instanceof AgentsApiError) || error.status >= 500) throw error;
      const head = error.code === 'plan_revision_conflict' ? await this.head(input.ownerId, input.sessionId) : undefined;
      output = { error: {
        code: error.code ?? 'invalid_plan_update',
        message: error.message.slice(0, 500),
        ...(head ? { current_plan: head } : {}),
      }, available_result_links: boundedAvailable(input.available) };
    }

    const now = this.clock.now();
    const call: import('./agents-ports.js').AgentResource<SessionPlanCall> = {
      ownerId: input.ownerId,
      id,
      collection: CALL_COLLECTION,
      createdAt: now,
      expiresAt: now + PLAN_CALL_RETENTION_SECONDS,
      revision: 1,
      value: { digest, output },
    };
    const observation = { ownerId: input.ownerId, collection: 'session_observations', id: input.sessionId, revision: input.observationRevision };
    const sessionObservation = { ownerId: input.ownerId, collection: 'sessions', id: input.sessionId, revision: input.sessionRevision };
    const writes = plan ? [
      { resource: { ownerId: input.ownerId, id: input.sessionId, collection: PLAN_COLLECTION, createdAt: headResource?.createdAt ?? now, revision: plan.revision, value: plan }, expectedRevision: headResource?.revision ?? 0 },
      { resource: { ownerId: input.ownerId, id: revisionId(input.sessionId, plan.revision), collection: REVISION_COLLECTION, createdAt: now, revision: 1, value: { revision: plan.revision, items: plan.items } satisfies SessionPlanRevision }, expectedRevision: 0 },
      { resource: call, expectedRevision: 0 },
    ] : [{ resource: call, expectedRevision: 0 }];
    try {
      await this.store.commit(writes, [sessionObservation, observation]);
      return output;
    } catch (error) {
      const winner = await this.store.get<SessionPlanCall>(input.ownerId, CALL_COLLECTION, id).catch(() => undefined);
      if (winner) return replay(winner.value, digest);
      if (!plan && conflict(error)) return output;
      if (!conflict(error)) throw error;

      // A competing Plan write won after this call read the previous head.
      // Preserve the function-call identity with a deterministic stale result.
      const currentHead = await this.head(input.ownerId, input.sessionId);
      const stale: SessionPlanToolOutput = { error: {
        code: 'plan_revision_conflict',
        message: `The Plan changed while this update was being saved. The current revision is ${currentHead.revision}; retry with that revision and the current item list.`,
        current_plan: currentHead,
      }, available_result_links: boundedAvailable(input.available) };
      try {
        await this.store.commit([{ resource: { ...call, value: { digest, output: stale } }, expectedRevision: 0 }], [sessionObservation, observation]);
      } catch (writeError) {
        const committed = await this.store.get<SessionPlanCall>(input.ownerId, CALL_COLLECTION, id).catch(() => undefined);
        if (committed) return replay(committed.value, digest);
        throw writeError;
      }
      return stale;
    }
  }
}

function validateResultLink(link: SessionPlanResultLink, input: Pick<Parameters<SessionPlanService['resolveCall']>[0], 'validArtifactVersions' | 'validActivityItems'>): void {
  if (link.kind === 'artifact') {
    if (!input.validArtifactVersions.has(`${link.artifact_id}:${link.version_sha256}`)) invalid('Artifact result must match a saved version in this Session.', 'items.result_links');
    return;
  }
  if (!input.validActivityItems.has(`${link.turn_id}:${link.item_id}`)) invalid('Activity result must identify an existing item in this Session.', 'items.result_links');
}

function replay(previous: SessionPlanCall, digest: string): SessionPlanToolOutput {
  if (previous.digest !== digest) return { error: { code: 'plan_call_conflict', message: 'This Plan tool call ID was already used with different arguments.' } };
  return previous.output;
}

function callResourceId(sessionId: string, turnId: string, callId: string): string {
  return `plan_call_${sha256Hex(canonicalJson([sessionId, turnId, callId]))}`;
}

function revisionId(sessionId: string, revision: number): string {
  return `${sessionId}_${String(revision).padStart(16, '0')}`;
}

function boundedAvailable(value: SessionPlanAvailableResults): SessionPlanAvailableResults {
  return { artifacts: value.artifacts.slice(-20), activity: value.activity.slice(-20) };
}

function conflict(error: unknown): boolean {
  return error instanceof AgentsApiError && error.status === 409 && error.code === 'conflict';
}
