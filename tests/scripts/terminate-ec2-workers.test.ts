import { describe, expect, it } from 'vitest';
import { deploymentWorkers, terminateDeploymentWorkers } from '../../scripts/terminate-ec2-workers.mjs';

const worker = (id: string, state = 'running') => ({ InstanceId: id, State: { Name: state }, LaunchTemplate: { LaunchTemplateId: 'lt-proof' },
  Tags: [{ Key: 'RatDeployment', Value: 'proof' }, { Key: 'RatRunId', Value: 'run-1' }, { Key: 'RatGeneration', Value: 'generation-1' }] });

describe('disposable EC2 worker cleanup', () => {
  it('selects only exact deployment/template workers with complete execution identity', () => {
    expect(deploymentWorkers([worker('owned'), worker('gone', 'terminated'),
      { ...worker('wrong-template'), LaunchTemplate: { LaunchTemplateId: 'lt-production' } },
      { ...worker('unrelated'), Tags: [] }, { ...worker('incomplete'), Tags: worker('x').Tags.slice(0, 1) },
    ], 'proof', 'lt-proof').map((value: { InstanceId: string }) => value.InstanceId)).toEqual(['owned']);
  });

  it('paginates, waits for termination and rescans for late worker starts', async () => {
    const pages = [
      { Reservations: [{ Instances: [worker('first')] }], NextToken: 'page-2' },
      { Reservations: [{ Instances: [worker('second', 'shutting-down')] }] },
      {}, { Reservations: [{ Instances: [worker('late')] }] }, {}, {},
    ];
    const commands: Array<{ name: string; input: unknown }> = [];
    const client = { send: async (command: { constructor: { name: string }; input: unknown }) => {
      commands.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === 'DescribeInstancesCommand' ? pages.shift()! : {};
    } };
    expect(await terminateDeploymentWorkers(client, 'proof', 'lt-proof', { delay: async () => {} })).toBe(2);
    expect(commands.filter(command => command.name === 'TerminateInstancesCommand').map(command => command.input)).toEqual([
      { InstanceIds: ['first'] }, { InstanceIds: ['late'] },
    ]);
    expect(commands[1]?.input).toMatchObject({ NextToken: 'page-2' });
  });

  it('fails closed when the worker remains alive', async () => {
    let time = 0;
    const client = { send: async () => ({ Reservations: [{ Instances: [worker('stuck', 'shutting-down')] }] }) };
    await expect(terminateDeploymentWorkers(client, 'proof', 'lt-proof', { now: () => time, delay: async () => { time += 2_000; }, timeoutMs: 3_000 })).rejects.toThrow('teardown deadline');
  });
});
