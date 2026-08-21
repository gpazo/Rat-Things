import type { ExecutionReference, JsonValue } from './contracts.js';

export const AGENT_APPROVAL_DECISIONS = [
  'accept',
  'accept-for-session',
  'decline',
  'cancel',
] as const;

export type AgentApprovalDecision = (typeof AGENT_APPROVAL_DECISIONS)[number];

export interface AgentRuntimeEventRecord {
  sequence: number;
  occurredAt: string;
  method: string;
  params: { [key: string]: JsonValue };
  requestId?: string;
}

export interface PendingAgentRequest {
  requestId: string;
  method: string;
  params: { [key: string]: JsonValue };
  receivedAt: string;
}

export interface AgentRuntimeSnapshot {
  runId: string;
  active: boolean;
  ready: boolean;
  /** First sequence still retained in the bounded live event ring. */
  oldestSequence: number;
  nextSequence: number;
  events: AgentRuntimeEventRecord[];
  pendingRequests: PendingAgentRequest[];
  turn?: { threadId: string; turnId: string };
}

export interface AgentInteractionTarget {
  runId: string;
  execution: ExecutionReference;
}
