import type {
  ArtifactReference,
  ExecutionReference,
  ListRunsResult,
  RunError,
  RunQueueMessage,
  RunRecord,
  RunResult,
  RunStatus,
} from '../domain/contracts.js';
import type {
  AgentInteractionTarget,
  AgentRuntimeSnapshot,
  AgentToolCallRecord,
} from '../domain/interaction.js';
import type { JsonValue } from '../domain/contracts.js';
import type { AgentSessionInputMessageParam } from '../domain/agents-api.js';

export interface CreateRunResult {
  created: boolean;
  record: RunRecord;
}

export interface RunStore {
  create(record: RunRecord): Promise<CreateRunResult>;
  get(runId: string): Promise<RunRecord | undefined>;
  list(ownerId: string, limit: number, nextToken?: string): Promise<ListRunsResult>;
  transition(runId: string, from: RunStatus[], to: RunStatus, patch?: Partial<RunRecord>): Promise<RunRecord>;
  attachExecution(runId: string, execution: ExecutionReference): Promise<RunRecord>;
  complete(runId: string, result: RunResult): Promise<RunRecord>;
  fail(runId: string, error: RunError, from?: RunStatus[]): Promise<RunRecord>;
}

export interface ArtifactStore {
  putJson(key: string, value: unknown): Promise<ArtifactReference>;
  getJson<T>(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T>;
  putBytes(key: string, value: Uint8Array, contentType: string): Promise<ArtifactReference>;
  getBytes(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<Uint8Array>;
  putStream(
    key: string,
    value: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<ArtifactReference>;
  getStream(
    reference: Pick<ArtifactReference, 'bucket' | 'key'>,
  ): Promise<AsyncIterable<Uint8Array>>;
  copy(
    source: ArtifactReference,
    key: string,
    contentType: string,
  ): Promise<ArtifactReference>;
}

export interface RunQueue {
  enqueue(message: RunQueueMessage): Promise<void>;
}

export interface ExecutionController {
  stop(execution: ExecutionReference, reason: string): Promise<void>;
}

export interface AgentInteractionController {
  environmentFiles?(target: AgentInteractionTarget, operation: import('./environment-file-ports.js').EnvironmentFileOperation): Promise<unknown>;
  startSessionTurn?(target: AgentInteractionTarget, turn: import('../domain/agents-api.js').Turn, input: AgentSessionInputMessageParam[], settings?: import('../domain/session-execution.js').SessionModelSettings): Promise<void>;
  events(target: AgentInteractionTarget, after?: number, limit?: number): Promise<AgentRuntimeSnapshot>;
  steer(target: AgentInteractionTarget & { turnId: string }, prompt: string, operationId?: string, input?: AgentSessionInputMessageParam[]): Promise<void>;
  interrupt(target: AgentInteractionTarget & { turnId: string }): Promise<void>;
  respond(target: AgentInteractionTarget, requestId: string, result: JsonValue): Promise<void>;

}

export interface AgentToolCallStore {
  beginAgentToolCall(record: AgentToolCallRecord): Promise<AgentToolCallRecord>;
  settleAgentToolCall(input: {
    runId: string;
    execution: ExecutionReference;
    requestId: string;
    status: 'succeeded' | 'failed';
    settledAt: string;
    resultDigest: string;
    error?: string;
  }): Promise<AgentToolCallRecord>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  random(): string;
  deterministic(ownerId: string, idempotencyKey: string): string;
}
