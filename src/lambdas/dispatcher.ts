import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';
import { InvalidStateTransitionError } from '../domain/state.js';
import type { RunQueueMessage, RunRecord, RunRequest } from '../domain/contracts.js';
import { createAwsClients, DynamoRunStore, S3ArtifactStore } from '../adapters/aws-runtime.js';
import {
  createExecutorRegistryFromEnv,
  type ExecutorRegistry,
  requiredEnv,
} from '../adapters/executors.js';
import type { ArtifactStore, RunStore } from '../core/ports.js';

export interface DispatcherDependencies {
  store: Pick<RunStore, 'get' | 'transition' | 'attachExecution' | 'fail'>;
  artifacts: Pick<ArtifactStore, 'getJson'>;
  executors: Pick<ExecutorRegistry, 'get'>;
}

let defaults: DispatcherDependencies | undefined;

export function createDispatcher(
  dependencies?: DispatcherDependencies,
): SQSHandler {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const resolved = dependencies ?? defaultDependencies();
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await dispatchRun(parseMessage(record.body), resolved);
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'dispatch failed',
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        }));
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

export const handler: SQSHandler = createDispatcher();

export async function dispatchRun(
  message: RunQueueMessage,
  dependencies: DispatcherDependencies = defaultDependencies(),
): Promise<void> {
  const { store, artifacts, executors } = dependencies;
  const current = await store.get(message.runId);
  if (!current || !isDispatchable(current)) return;
  const request = await artifacts.getJson<RunRequest>(current.input);
  const backend = request.execution?.backend ?? defaultBackend();
  const executor = executors.get(backend);
  if (current.status === 'queued') await store.transition(current.runId, ['queued'], 'dispatching');
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

function defaultDependencies(): DispatcherDependencies {
  if (defaults) return defaults;
  const clients = createAwsClients();
  defaults = {
    store: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME')),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    executors: createExecutorRegistryFromEnv(),
  };
  return defaults;
}

function isDispatchable(run: RunRecord): boolean {
  return run.status === 'queued' ||
    run.status === 'dispatching' ||
    (run.status === 'running' && (!run.execution || run.execution.id === 'pending'));
}

function parseMessage(body: string): RunQueueMessage {
  const parsed = JSON.parse(body) as Partial<RunQueueMessage>;
  if (parsed.version !== '1' || typeof parsed.runId !== 'string' || typeof parsed.traceId !== 'string') {
    throw new Error('invalid run queue message');
  }
  return parsed as RunQueueMessage;
}

function defaultBackend(): 'ecs' | 'microvm' {
  const value = process.env.DEFAULT_EXECUTION_BACKEND ?? 'ecs';
  if (value !== 'ecs' && value !== 'microvm') throw new Error('DEFAULT_EXECUTION_BACKEND is invalid');
  return value;
}

function retryableStartError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return ['ThrottlingException', 'ServiceUnavailableException', 'TooManyRequestsException'].includes(name);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
