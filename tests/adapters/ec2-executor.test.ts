import { describe, expect, it, vi } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { Ec2ExecutionInspector, Ec2RunExecutor } from '../../src/adapters/ec2-executor.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const run = { runId: 'run', requestHash: 'hash', agentsSession: { sessionId: 'session' } } as RunRecord;
describe('dedicated Session workers', () => {
  it('reuses the launch identity and immutable template on dispatcher retries', async () => {
    const send = vi.fn().mockResolvedValue({ Instances: [{ InstanceId: 'i-worker' }] });
    const executor = new Ec2RunExecutor({ send } as unknown as EC2Client, {
      launchTemplateId: 'lt-worker', launchTemplateVersion: '17', deployment: 'test',
    });
    const first = await executor.start(run, { version: '1', prompt: 'work' }, 'trace');
    const second = await executor.start(run, { version: '1', prompt: 'work' }, 'retry');
    expect(second).toEqual(first);
    expect(send.mock.calls[0]![0].input).toEqual(send.mock.calls[1]![0].input);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      LaunchTemplate: { LaunchTemplateId: 'lt-worker', Version: '17' },
      MinCount: 1, MaxCount: 1, ClientToken: first.generation,
    });
    expect(send.mock.calls[0]![0].input.UserData).toBeUndefined();
    const { agentsSession: _binding, ...bareRun } = run;
    await expect(executor.start(bareRun, { version: '1', prompt: 'work' }, 'trace')).rejects.toThrow('Session binding');
  });

  it('requires both AWS identity and matching root-supervised health', async () => {
    const execution = { backend: 'ec2' as const, id: 'i-worker', generation: 'generation' };
    const instance = { InstanceId: execution.id, State: { Name: 'running' }, Tags: [
      { Key: 'RatDeployment', Value: 'test' }, { Key: 'RatRunId', Value: 'run' }, { Key: 'RatGeneration', Value: 'generation' },
    ] };
    const send = vi.fn().mockResolvedValue({ Reservations: [{ Instances: [instance] }] });
    const health = vi.fn().mockResolvedValue({ active: true, workerConnected: true, runId: 'run', generation: 'generation' });
    const inspector = new Ec2ExecutionInspector({ send } as unknown as EC2Client, 'test', health);
    expect(await inspector.inspect('run', execution)).toEqual({ kind: 'active' });
    health.mockResolvedValueOnce({ active: true, workerConnected: true, runId: 'run', generation: 'other' });
    expect((await inspector.inspect('run', execution)).kind).toBe('conflict');
    health.mockClear();
    expect((await inspector.inspect('other-run', execution)).kind).toBe('conflict');
    expect(health).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ Reservations: [{ Instances: [{ ...instance, State: { Name: 'terminated' } }] }] });
    expect((await inspector.inspect('run', execution)).kind).toBe('terminal');
    send.mockRejectedValueOnce(new Error('Network unavailable'));
    expect((await inspector.inspect('run', execution)).kind).toBe('unknown');
  });
});
