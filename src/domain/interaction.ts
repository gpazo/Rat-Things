import type { ExecutionReference, JsonValue } from './contracts.js';

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

export const AGENT_TOOL_CALL_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'interrupted',
] as const;

export type AgentToolCallStatus = (typeof AGENT_TOOL_CALL_STATUSES)[number];

/**
 * Durable, bounded evidence for one host dynamic-tool call. Arguments and
 * results are represented only by digests so provider data and secrets do not
 * migrate into the Runs table.
 */
export interface AgentToolCallRecord {
  version: '1';
  runId: string;
  requestId: string;
  method: 'item/tool/call';
  executionId: string;
  executionGeneration: string;
  namespace: string | null;
  tool: string;
  argumentDigest: string;
  admittedToolsDigest: string;
  status: AgentToolCallStatus;
  startedAt: string;
  settledAt?: string;
  resultDigest?: string;
  error?: string;
}
