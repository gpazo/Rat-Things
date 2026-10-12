import { afterEach, describe, expect, it, vi } from 'vitest';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { EC2Client } from '@aws-sdk/client-ec2';
import { workspaceSourceStopped } from '../../src/adapters/workspace-source-stopped.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const source = { runId: 'source', generation: 'generation' };
const record = (backend: 'microvm' | 'ec2' = 'microvm') => ({ runId: source.runId, status: 'succeeded', execution: { backend, id: 'worker-id', generation: source.generation } }) as RunRecord;
afterEach(() => vi.restoreAllMocks());

describe('checkpoint recovery termination evidence', () => {
  it.each(['RUNNING', 'SUSPENDING', 'SUSPENDED', 'TERMINATING', undefined])('does not recover a MicroVM in state %s', async state => {
    vi.spyOn(LambdaMicrovmsClient.prototype, 'send').mockResolvedValue({ state } as never);
    expect(await workspaceSourceStopped(async () => record(), 'us-west-2')(source)).toBe(false);
  });
  it('requires both the exact generation and a terminal Run before inspecting its physical worker', async () => {
    const send = vi.spyOn(LambdaMicrovmsClient.prototype, 'send').mockResolvedValue({ state: 'TERMINATED' } as never);
    for (const run of [undefined, { ...record(), status: 'running' as const }, { ...record(), execution: { ...record().execution!, generation: 'other' } }]) {
      expect(await workspaceSourceStopped(async () => run, 'us-west-2')(source)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(await workspaceSourceStopped(async () => record(), 'us-west-2')(source)).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({ microvmIdentifier: 'worker-id' });
  });
  it.each([
    ['ResourceNotFoundException', 'missing', true], ['GoneException', 'gone', true],
    ['ValidationException', 'MicroVM has been terminated', true],
    ['ValidationException', 'MicroVM is not terminated', false],
    ['ValidationException', 'invalid request', false], ['AccessDeniedException', 'not authorized', false],
  ])('interprets %s (%s) conservatively', async (name, message, expected) => {
    vi.spyOn(LambdaMicrovmsClient.prototype, 'send').mockRejectedValue(Object.assign(new Error(message), { name }));
    expect(await workspaceSourceStopped(async () => record(), 'us-west-2')(source)).toBe(expected);
  });
  it.each(['running', 'stopping', 'stopped', 'shutting-down', 'terminated'])('treats EC2 state %s as irreversible only when terminated', async state => {
    vi.spyOn(EC2Client.prototype, 'send').mockResolvedValue({ Reservations: [{ Instances: [{ State: { Name: state } }] }] } as never);
    expect(await workspaceSourceStopped(async () => record('ec2'), 'us-west-2')(source)).toBe(state === 'terminated');
  });
});
