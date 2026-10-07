import type { ExecutionReference, JsonValue } from './contracts.js';
import type { AgentSessionItem } from './agents-api.js';

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
  /** Complete current-turn items from the harness, independent of the bounded event ring. */
  sessionItems?: AgentSessionItem[];
  turn?: { threadId: string; turnId: string };
}

export interface AgentInteractionTarget {
  runId: string;
  execution: ExecutionReference;
}
