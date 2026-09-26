import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import type { DedicatedWorker, DedicatedWorkerInventory } from '../execution/terminal-worker-reconciler.js';

/** Inventory only this deployment's dedicated template; retained Runs are the final authority. */
export class Ec2WorkerInventory implements DedicatedWorkerInventory {
  public constructor(private readonly client: EC2Client, private readonly deployment: string, private readonly templateId: string) {
    if (!deployment || !templateId) throw new Error('Dedicated worker inventory requires deployment and template identity');
  }

  public async *workers(): AsyncIterable<DedicatedWorker> {
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(new DescribeInstancesCommand({
        Filters: [{ Name: 'tag:RatDeployment', Values: [this.deployment] },
          { Name: 'tag:aws:ec2launchtemplate:id', Values: [this.templateId] },
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopped'] }],
        MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      for (const instance of page.Reservations?.flatMap(value => value.Instances ?? []) ?? []) {
        const tags = Object.fromEntries((instance.Tags ?? []).map(tag => [tag.Key, tag.Value]));
        if (!instance.InstanceId || tags.RatDeployment !== this.deployment || tags['aws:ec2launchtemplate:id'] !== this.templateId
          || !tags.RatRunId || !tags.RatGeneration || !['pending', 'running', 'stopped'].includes(instance.State?.Name ?? '')) continue;
        yield { runId: tags.RatRunId, execution: { backend: 'ec2', id: instance.InstanceId, generation: tags.RatGeneration } };
      }
      nextToken = page.NextToken;
    } while (nextToken);
  }

  public async stop(worker: DedicatedWorker): Promise<void> {
    await this.client.send(new TerminateInstancesCommand({ InstanceIds: [worker.execution.id] }));
  }
}
