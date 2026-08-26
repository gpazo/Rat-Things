import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';
import { createAwsClients, DynamoRunStore, S3ArtifactStore } from '../adapters/aws-runtime.js';
import {
  createExecutorRegistryFromEnv,
  requiredEnv,
  type MicrovmStartupObservation,
} from '../adapters/executors.js';
import type { ExecutionBackend, RunQueueMessage } from '../domain/contracts.js';
import {
  parseRunQueueMessage,
  RunDispatcher,
  type RunDispatcherOptions,
} from '../execution/dispatcher.js';
import { emitMetric, emitSqsQueueDelay } from './metrics.js';

export type DispatcherDependencies = Omit<RunDispatcherOptions, 'defaultBackend'> & {
  defaultBackend?: ExecutionBackend;
};

let defaults: DispatcherDependencies | undefined;

export function createDispatcher(dependencies?: DispatcherDependencies): SQSHandler {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const resolved = dependencies ?? defaultDependencies();
    const dispatcher = new RunDispatcher({
      store: resolved.store,
      artifacts: resolved.artifacts,
      executors: resolved.executors,
      defaultBackend: resolved.defaultBackend ?? defaultExecutionBackend(),
    });
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const startedAt = Date.now();
      emitSqsQueueDelay('dispatcher', record, startedAt);
      try {
        await dispatcher.dispatch(parseRunQueueMessage(record.body));
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'dispatch failed',
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        }));
        failures.push({ itemIdentifier: record.messageId });
      } finally {
        emitMetric('dispatcher', 'ProcessingDuration', Date.now() - startedAt, 'Milliseconds');
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
  return new RunDispatcher({
    store: dependencies.store,
    artifacts: dependencies.artifacts,
    executors: dependencies.executors,
    defaultBackend: dependencies.defaultBackend ?? defaultExecutionBackend(),
  }).dispatch(message);
}

function defaultDependencies(): DispatcherDependencies {
  if (defaults) return defaults;
  const clients = createAwsClients();
  defaults = {
    store: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME')),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    executors: createExecutorRegistryFromEnv(emitMicrovmStartupObservation),
  };
  return defaults;
}

export function emitMicrovmStartupObservation(observation: MicrovmStartupObservation): void {
  emitMetric(
    'dispatcher',
    observation.mode === 'launch'
      ? 'MicrovmLaunchRequestDuration'
      : 'MicrovmResumeRequestDuration',
    observation.durationMs,
    'Milliseconds',
  );
  if (observation.outcome === 'fallback') {
    emitMetric('dispatcher', 'MicrovmResumeFallback', 1, 'Count');
  } else if (observation.outcome === 'failed') {
    emitMetric('dispatcher', 'MicrovmStartupFailure', 1, 'Count');
  }
}

function defaultExecutionBackend(): ExecutionBackend {
  const value = process.env.DEFAULT_EXECUTION_BACKEND ?? 'microvm';
  if (value !== 'microvm') {
    throw new Error('DEFAULT_EXECUTION_BACKEND is invalid');
  }
  return value;
}
