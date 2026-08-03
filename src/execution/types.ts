import type {
  ExecutionBackend,
  ExecutionReference,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';

export interface RunExecutor {
  readonly backend: ExecutionBackend;
  start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference>;
  stop(id: string, reason: string): Promise<void>;
}

export interface ExecutionBackendRegistry {
  get(backend: ExecutionBackend): RunExecutor;
}
