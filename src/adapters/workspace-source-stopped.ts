import { GetMicrovmCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import type { RunRecord } from '../domain/contracts.js';
import type { WorkspaceExecution } from '../domain/workspace-checkpoint.js';
import { isTerminal } from '../domain/state.js';

/** Liveness terminal/terminating is insufficient: workspace recovery requires no possible writer. */
export function workspaceSourceStopped(read: (runId: string) => Promise<RunRecord | undefined>, region: string) {
  const microvms = new LambdaMicrovmsClient({ region });
  const ec2 = new EC2Client({ region });
  return async (source: WorkspaceExecution): Promise<boolean> => {
    const run = await read(source.runId);
    if (!run || !isTerminal(run.status) || run.execution?.generation !== source.generation) return false;
    try {
      if (run.execution.backend === 'microvm') {
        return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution.id }))).state === 'TERMINATED';
      }
      if (run.execution.backend === 'ec2') {
        const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [run.execution.id] }));
        return result.Reservations?.[0]?.Instances?.[0]?.State?.Name === 'terminated';
      }
      return false;
    } catch (error) {
      if (!(error instanceof Error)) return false;
      if (run.execution.backend === 'microvm') return ['ResourceNotFoundException', 'GoneException'].includes(error.name)
        || error.name === 'ValidationException' && /\bmicrovm\b.*\b(?:has been|is(?: already)?) terminated\b/i.test(error.message);
      return run.execution.backend === 'ec2' && error.name === 'InvalidInstanceID.NotFound';
    }
  };
}
