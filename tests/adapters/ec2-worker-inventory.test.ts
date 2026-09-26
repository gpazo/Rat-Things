import { expect, it, vi } from 'vitest';
import { DescribeInstancesCommand, TerminateInstancesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { Ec2WorkerInventory } from '../../src/adapters/ec2-worker-inventory.js';
const tags = { RatDeployment: 'deployment', RatRunId: 'run', RatGeneration: 'generation', 'aws:ec2launchtemplate:id': 'lt-worker' };
const instance = (overrides = {}, state = 'running') => ({ InstanceId: 'i-worker', State: { Name: state }, Tags: Object.entries({ ...tags, ...overrides }).map(([Key, Value]) => ({ Key, Value })) });
it('paginates and verifies deployment, template, state and complete attachment tags before exposing a candidate', async () => {
  const send = vi.fn().mockResolvedValueOnce({ NextToken: 'page2', Reservations: [{ Instances: [
    instance({ RatDeployment: 'other' }), instance({ 'aws:ec2launchtemplate:id': 'other' }), instance({ RatRunId: '' }),
    instance({ RatGeneration: '' }), instance({}, 'terminated'), instance({}, 'shutting-down'),
  ] }] }).mockResolvedValueOnce({ Reservations: [{ Instances: [instance()] }] }).mockResolvedValue({});
  const inventory = new Ec2WorkerInventory({ send } as unknown as EC2Client, 'deployment', 'lt-worker');
  const workers = []; for await (const worker of inventory.workers()) workers.push(worker);
  expect(workers).toEqual([{ runId: 'run', execution: { backend: 'ec2', id: 'i-worker', generation: 'generation' } }]);
  expect(send.mock.calls[0]![0]).toBeInstanceOf(DescribeInstancesCommand);
  expect(send.mock.calls[1]![0].input).toMatchObject({ NextToken: 'page2', Filters: expect.arrayContaining([{ Name: 'tag:RatDeployment', Values: ['deployment'] }]) });
  await inventory.stop(workers[0]!);
  expect(send.mock.calls[2]![0]).toBeInstanceOf(TerminateInstancesCommand);
  expect(send.mock.calls[2]![0].input).toEqual({ InstanceIds: ['i-worker'] });
});
