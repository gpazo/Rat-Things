import type { ArtifactStore, RunStore } from '../core/ports.js';
import type {
  ExecutionBackend,
  RunQueueMessage,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import { executionGeneration } from './generation.js';
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
    // A threaded Run exists before its predecessor state is known. Conversation
    // wake-ups prepare its trusted execution input and only then enqueue it.
    // Ignore an accidental/reconciler wake-up while that preparation is pending.
    if (current.conversation && !current.executionInput) return;
    const request = await artifacts.getJson<RunRequest>(current.executionInput ?? current.input);
    const backend = request.execution?.backend ?? this.options.defaultBackend;
    const executor = executors.get(backend);
    let dispatching = current;
    const generation = current.execution?.generation ?? executionGeneration(current);
    if (current.status === 'queued') {
      try {
        dispatching = await store.transition(current.runId, ['queued'], 'dispatching', {
          execution: { backend, id: 'pending', generation },
        });
      } catch (error) {
        if (error instanceof InvalidStateTransitionError) {
          const latest = await store.get(current.runId);
          // Another delivery already claimed this queued run. That delivery is
          // responsible for starting and attaching the idempotent execution.
          if (latest && latest.status !== 'queued') return;
        }
        throw error;
      }
    }
    let execution;
    try {
      execution = await executor.start(dispatching, request, message.traceId);
    } catch (error) {
      if (retryableStartError(error)) throw error;
      await store.fail(current.runId, {
        code: 'executor_start_failed',
        message: safeMessage(error),
        retryable: false,
      }, ['dispatching']);
      return;
    }

    if (execution.generation !== generation) {
      await executor.stop(execution.id, 'executor returned the wrong execution generation');
      await store.fail(current.runId, {
        code: 'executor_identity_mismatch',
        message: 'executor returned an invalid execution identity',
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
    (run.status === 'dispatching' && (!run.execution || run.execution.id === 'pending')) ||
    (run.status === 'running' && (!run.execution || run.execution.id === 'pending'));
}

function retryableStartError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (['ThrottlingException', 'ServiceUnavailableException', 'TooManyRequestsException'].includes(name)) {
    return true;
  }
  const message = safeMessage(error).toLowerCase();
  // Lambda MicroVM control-plane gateway failures have occasionally returned
  // HTML. The AWS SDK surfaces those as a JSON deserialization SyntaxError
  // rather than a ServiceUnavailableException, but retrying the idempotent
  // RunMicrovm request is still the correct response.
  if (message.includes('deserialization error') && message.includes('is not valid json')) {
    return true;
  }
  const status = awsHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return name === 'ConflictException' &&
    message.includes('creation in progress') &&
    message.includes('clienttoken');
}

function awsHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    $response?: { statusCode?: unknown; status?: unknown };
  };
  const status = candidate.$metadata?.httpStatusCode ??
    candidate.$response?.statusCode ??
    candidate.$response?.status;
  return typeof status === 'number' ? status : undefined;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
