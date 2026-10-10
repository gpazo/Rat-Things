import type { ExecutionBackend } from '../domain/contracts.js';
import { createHash } from 'node:crypto';
import type { Agent, AgentSession, AgentToolParam, SessionCreateParams } from '../domain/agents-api.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import { sessionAgent } from './session-planning.js';

export interface SessionPreparation {
  agent: AgentSession['agent'];
  placement?: ExecutionBackend;
  now: number;
  created?: boolean;
  abandoned?: boolean;
  deadline: number;
  requestDigest: string;
  /** Saved Agent settings only; never inline Session authorization or env values. */
  inheritedTools: Agent['tools'];
}

export function planSessionPreparation(input: SessionCreateParams, id: string, now: number, saved?: Agent, placement: ExecutionBackend = 'microvm'): SessionPreparation {
  return {
    placement, agent: sessionAgent(input.agent, id, now, saved), now, deadline: now + 86_400, requestDigest: requestDigest(input),
    inheritedTools: input.agent?.tools === undefined ? saved?.tools ?? [] : [],
  };
}

/** Retain completed/abandoned identities to fence delayed retries and deletion. */
export function planPreparationReconciliation(preparation: SessionPreparation, now: number) {
  if (preparation.created) return { type: 'created' as const };
  if (preparation.abandoned) return { type: 'cleanup' as const };
  if (now < preparation.deadline) return { type: 'wait' as const, retryAfterSeconds: preparation.deadline - now };
  return { type: 'cleanup' as const };
}

export function requireActivePreparation(preparation: SessionPreparation, now: number): void {
  if (preparation.abandoned || now >= preparation.deadline) {
    throw new AgentsApiError(409, 'Session preparation expired. Create a new Session.', 'session_preparation_expired');
  }
}

export function preparationTools(preparation: SessionPreparation, input: SessionCreateParams): AgentToolParam[] {
  if (preparation.requestDigest !== requestDigest(input)) {
    throw new AgentsApiError(409, 'The interrupted Session was prepared from a different request.', 'idempotency_conflict');
  }
  // An explicit null clears confidential transports as well as public settings.
  if (input.agent?.tools !== undefined) return input.agent.tools ?? [];
  return preparation.inheritedTools;
}

function requestDigest(input: SessionCreateParams): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
