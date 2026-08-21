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
  AgentApprovalDecision,
  AgentInteractionTarget,
  AgentRuntimeSnapshot,
} from '../domain/interaction.js';
import type { JsonValue } from '../domain/contracts.js';
import type {
  ListRoutinesResult,
  RoutineRecord,
  RoutineStatus,
} from '../domain/routines.js';

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
  events(target: AgentInteractionTarget, after?: number, limit?: number): Promise<AgentRuntimeSnapshot>;
  steer(target: AgentInteractionTarget, prompt: string): Promise<void>;
  interrupt(target: AgentInteractionTarget): Promise<void>;
  approve(
    target: AgentInteractionTarget,
    requestId: string,
    decision: AgentApprovalDecision,
    reason?: string,
  ): Promise<void>;
  respond(target: AgentInteractionTarget, requestId: string, result: JsonValue): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  random(): string;
  deterministic(ownerId: string, idempotencyKey: string): string;
}

export interface RoutineStore {
  create(record: RoutineRecord): Promise<void>;
  get(routineId: string): Promise<RoutineRecord | undefined>;
  list(ownerId: string, limit: number, nextToken?: string): Promise<ListRoutinesResult>;
  listDue(cutoff: string, limit: number): Promise<RoutineRecord[]>;
  setStatus(
    ownerId: string,
    routineId: string,
    status: Exclude<RoutineStatus, 'deleted'>,
    nextRunAt: string,
    updatedAt: string,
  ): Promise<RoutineRecord>;
  softDelete(
    ownerId: string,
    routineId: string,
    updatedAt: string,
    expiresAt: number,
  ): Promise<RoutineRecord>;
  advance(
    routineId: string,
    expectedRunAt: string,
    nextRunAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean>;
}
