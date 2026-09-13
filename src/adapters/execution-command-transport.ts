import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createAwsClients, DynamoRunStore, S3ArtifactStore } from './aws-runtime.js';
import { DynamoAgentsStore } from './dynamo-agents-store.js';
import { ExecutionCommandService } from '../core/execution-command-service.js';
import { sameExecution, type ExecutionCommandRequest, type ExecutionCommandTarget } from '../core/execution-command-planning.js';

export function executionCommandDependencies() {
  const clients = createAwsClients(undefined, { operationTimeoutMs: 10_000 });
  const runs = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'), Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000));
  const store = new DynamoAgentsStore(clients.dynamodb, required('AGENTS_TABLE_NAME'),
    new S3ArtifactStore(clients.s3, required('DEFINITION_BUCKET'), process.env.DEFINITION_KMS_KEY_ARN
      ? { algorithm: 'aws:kms', kmsKeyId: process.env.DEFINITION_KMS_KEY_ARN } : { algorithm: 'AES256' }));
  return { runs, commands: new ExecutionCommandService({ store, now: Date.now, id: randomUUID, pause }) };
}

export function createEc2CommandTransport() {
  const { runs, commands } = executionCommandDependencies();
  return async (target: ExecutionCommandTarget, request: ExecutionCommandRequest): Promise<unknown> => {
    const run = await runs.get(target.runId);
    if (!run?.execution || !sameExecution(target, { runId: run.runId, execution: run.execution })
      || !['dispatching', 'running', 'cancelling'].includes(run.status)) throw new Error('Execution is no longer active.');
    const response = await commands.request(run.ownerId, target, request);
    if (response.status < 200 || response.status >= 300) throw new Error(`Worker control returned HTTP ${response.status}.`);
    return response.body;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
