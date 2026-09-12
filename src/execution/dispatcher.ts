import type { ArtifactStore, RunStore } from '../core/ports.js';
import type {
  ExecutionBackend,
  RunQueueMessage,
  RunRequest,
} from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import { executionGeneration } from './generation.js';
import { dispatchAdmission, executorStartFailure } from './dispatch-planning.js';
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
    const admission = dispatchAdmission(await store.get(message.runId));
    if (admission.kind === 'ignore') return;
    const { run: current, input } = admission;
    const request = await artifacts.getJson<RunRequest>(input);
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
      const failure = executorStartFailure(error);
      if (failure.kind === 'retry') throw error;
      await store.fail(current.runId, failure.error, ['dispatching']);
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
