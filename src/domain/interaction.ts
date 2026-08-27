import type { ExecutionReference, JsonValue } from './contracts.js';
import type { ThingSpec } from './things.js';

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

export const COMPUTER_VIEWPORT = { width: 1280, height: 720 } as const;

export type ComputerControlMode = 'agent' | 'human';

export type HumanBrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; ref?: string; x?: number; y?: number }
  | { type: 'type'; ref?: string; text: string; clear?: boolean; submit?: boolean }
  | { type: 'press'; key: string }
  | { type: 'select'; ref: string; value: string }
  | { type: 'scroll'; deltaX?: number; deltaY: number }
  | { type: 'wait'; milliseconds: number }
  | { type: 'back' };

export interface ComputerTeachStatus {
  state: 'idle' | 'recording';
  recordingId?: string;
  name?: string;
  startedAt?: string;
  maximumDurationMs?: number;
  demonstratedSteps?: number;
}

/** Public, owner-scoped view of the browser inside an active Run MicroVM. */
export interface ComputerSnapshot {
  version: '1';
  runId: string;
  available: true;
  control: ComputerControlMode;
  viewport: typeof COMPUTER_VIEWPORT;
  observedAt: string;
  page: { url: string; title: string };
  imageDataUrl: string;
  takeover?: { startedAt: string; expiresAt: string };
  teach: ComputerTeachStatus;
}

export interface ComputerTakeoverReceipt {
  version: '1';
  runId: string;
  control: ComputerControlMode;
  takeover?: { startedAt: string; expiresAt: string };
}

export interface TeachRecordingInput {
  name: string;
  goal?: string;
}

export interface TeachRecordingResult {
  version: '1';
  recordingId: string;
  name: string;
  startedAt: string;
  stoppedAt: string;
  demonstratedSteps: number;
  discarded: boolean;
  /** Safe, unpublished automation proposal. Typed/select values are parameters, not captured values. */
  draft?: ThingSpec;
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
