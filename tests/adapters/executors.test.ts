import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';

import { MicrovmRunExecutor } from '../../src/adapters/executors.js';
import type { RunRecord, RunRequest } from '../../src/domain/contracts.js';

const record: RunRecord = {
  runId: '11111111-1111-5111-8111-111111111111',
  ownerId: 'test-owner',
  ownerCreated: 'test-owner#2026-08-02T00:00:00.000Z#11111111-1111-5111-8111-111111111111',
  status: 'dispatching',
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  expiresAt: 2_000_000_000,
  requestHash: 'a'.repeat(64),
  input: { bucket: 'input-bucket', key: 'runs/input.json', sha256: 'b'.repeat(64) },
  sourceKind: 'api',
};

const request: RunRequest = {
  version: '1',
  prompt: 'Review this change.',
  execution: { backend: 'microvm', timeoutSeconds: 300 },
};

describe('executor idempotency', () => {
  it('keeps RunMicrovm input stable when a reconciler supplies a new trace ID', async () => {
    const sendMicrovm = vi.fn().mockResolvedValue({ microvmId: 'microvm-1' });
    const parameterValues: Record<string, string> = {
      image: 'arn:aws:lambda:region:account:microvm-image/runtime',
      version: '3',
    };
    const sendSsm = vi.fn().mockImplementation((command: { input: { Name: string } }) =>
      Promise.resolve({ Parameter: { Value: parameterValues[command.input.Name] } }),
    );
    const executor = new MicrovmRunExecutor(
      { send: sendMicrovm } as unknown as LambdaMicrovmsClient,
      { send: sendSsm } as unknown as SSMClient,
      {
        imageParameterName: 'image',
        imageVersionParameterName: 'version',
        executionRoleArn: 'arn:aws:iam::account:role/runtime',
        logGroupName: '/aws/lambda-microvm/runtime',
        runsTableName: 'runs',
        artifactBucket: 'artifacts',
        eventBusName: 'events',
        region: 'us-east-1',
        allowedRepositoryHosts: 'github.com,gitlab.com',
        allowedSandboxModes: 'read-only,workspace-write',
        defaultAgentDriver: 'mock',
        allowAgentAwsCredentialChain: false,
      },
    );

    await executor.start(record, { ...request, execution: { backend: 'microvm', timeoutSeconds: 300 } }, 'original');
    await executor.start(record, { ...request, execution: { backend: 'microvm', timeoutSeconds: 300 } }, 'reconcile:new');

    expect(sendMicrovm).toHaveBeenCalledTimes(2);
    expect(sendMicrovm.mock.calls[0]?.[0].input).toEqual(sendMicrovm.mock.calls[1]?.[0].input);
    expect(JSON.parse(sendMicrovm.mock.calls[0]?.[0].input.runHookPayload)).toMatchObject({
      runId: record.runId,
      traceId: record.runId,
    });
  });
});
