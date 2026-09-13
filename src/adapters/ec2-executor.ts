import { EC2Client, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import type { ExecutionReference, RunRecord, RunRequest } from '../domain/contracts.js';
import type { RunExecutor } from '../execution/types.js';
import type { ExecutionInspection, ExecutionInspector } from '../execution/reconciler.js';
import { executionGeneration } from '../execution/generation.js';

/** A dedicated VM is the isolation boundary; the pinned template has no inbound access. */
export class Ec2RunExecutor implements RunExecutor {
  public readonly backend = 'ec2' as const;
  public constructor(private readonly client: EC2Client, private readonly options: {
    launchTemplateId: string; launchTemplateVersion: string; deployment: string;
  }) {}

  public async start(record: RunRecord, _request: RunRequest, _traceId: string): Promise<ExecutionReference> {
    if (!record.agentsSession) throw new Error('EC2 workers require an Agents Session binding.');
    const generation = record.execution?.generation ?? executionGeneration(record);
    const tags = [
      { Key: 'RatDeployment', Value: this.options.deployment },
      { Key: 'RatRunId', Value: record.runId },
      { Key: 'RatGeneration', Value: generation },
    ];
    const result = await this.client.send(new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateId: this.options.launchTemplateId, Version: this.options.launchTemplateVersion },
      MinCount: 1, MaxCount: 1, ClientToken: generation,
      TagSpecifications: [{ ResourceType: 'instance', Tags: tags }, { ResourceType: 'volume', Tags: tags }],
    }));
    const id = result.Instances?.[0]?.InstanceId;
    if (!id || result.Instances?.length !== 1) throw new Error('EC2 did not return one isolated worker.');
    return { backend: 'ec2', id, generation };
  }

  public async stop(id: string): Promise<void> {
    await this.client.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
  }
}

export class Ec2ExecutionInspector implements ExecutionInspector {
  public constructor(private readonly client: EC2Client, private readonly deployment: string,
    private readonly health: (runId: string, execution: ExecutionReference) => Promise<unknown>) {}

  public async inspect(runId: string, execution: ExecutionReference): Promise<ExecutionInspection> {
    if (execution.backend !== 'ec2' || !execution.generation) return { kind: 'conflict', reason: 'Execution identity is incomplete.' };
    try {
      const response = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [execution.id] }));
      const instance = response.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((value) => value.InstanceId === execution.id);
      if (!instance) return { kind: 'absent', reason: 'The attached EC2 worker no longer exists.' };
      const tags = Object.fromEntries((instance.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
      if (tags.RatDeployment !== this.deployment || tags.RatRunId !== runId || tags.RatGeneration !== execution.generation) {
        return { kind: 'conflict', reason: 'The EC2 worker belongs to a different execution.' };
      }
      const state = instance.State?.Name;
      if (state === 'terminated' || state === 'shutting-down' || state === 'stopped') return { kind: 'terminal', reason: `The EC2 worker is ${state}.` };
      if (state !== 'running') return { kind: 'unknown', reason: 'The EC2 worker is not running.' };
      const health = await this.health(runId, execution) as Record<string, unknown>;
      return health.active === true && health.workerConnected === true && health.runId === runId && health.generation === execution.generation
        ? { kind: 'active' } : { kind: 'conflict', reason: 'The worker health identity does not match its attachment.' };
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidInstanceID.NotFound') return { kind: 'absent', reason: 'The attached EC2 worker no longer exists.' };
      return { kind: 'unknown', reason: 'The EC2 worker could not be verified.' };
    }
  }
}
