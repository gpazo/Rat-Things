import type { ArtifactStore, RunStore } from '../core/ports.js';
import type {
  ExecutionBackend,
  RunQueueMessage,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import type { ExecutionBackendRegistry } from './types.js';

export interface RunDispatcherOptions {
  store: Pick<RunStore, 'get' | 'transition' | 'attachExecution' | 'fail'>;
  artifacts: Pick<ArtifactStore, 'getJson'>;
  executors: ExecutionBackendRegistry;
  defaultBackend: ExecutionBackend;
}

export class RunDispatcher {
  public constructor(private readonly options: RunDispatcherOptions) {}

  public async dispatch(message: RunQueueMessage): Promise<void> {
    const { store, artifacts, executors } = this.options;
    const current = await store.get(message.runId);
    if (!current || !isDispatchable(current)) return;
    const request = await artifacts.getJson<RunRequest>(current.input);
    const backend = request.execution?.backend ?? this.options.defaultBackend;
    const executor = executors.get(backend);
    if (current.status === 'queued') {
      await store.transition(current.runId, ['queued'], 'dispatching');
    }
    let execution;
    try {
      execution = await executor.start(current, request, message.traceId);
    } catch (error) {
      if (retryableStartError(error)) throw error;
      await store.fail(current.runId, {
        code: 'executor_start_failed',
        message: safeMessage(error),
        retryable: false,
      }, ['dispatching']);
      return;
    }

    try {
      await store.attachExecution(current.runId, execution);
    } catch (error) {
      await executor.stop(execution.id, 'run was cancelled while the executor was starting');
      if (error instanceof InvalidStateTransitionError) {
        const latest = await store.get(current.runId);
        if (latest?.status === 'cancelling') {
          await store.transition(current.runId, ['cancelling'], 'cancelled');
          return;
        }
      }
      throw error;
    }
  }
}

export function parseRunQueueMessage(body: string): RunQueueMessage {
  const parsed = JSON.parse(body) as Partial<RunQueueMessage>;
  if (parsed.version !== '1' || typeof parsed.runId !== 'string' || typeof parsed.traceId !== 'string') {
    throw new Error('invalid run queue message');
  }
  return parsed as RunQueueMessage;
}

function isDispatchable(run: RunRecord): boolean {
  return run.status === 'queued' ||
    run.status === 'dispatching' ||
    (run.status === 'running' && (!run.execution || run.execution.id === 'pending'));
}

function retryableStartError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return ['ThrottlingException', 'ServiceUnavailableException', 'TooManyRequestsException'].includes(name);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
