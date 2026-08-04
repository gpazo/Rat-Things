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
    expect(sendSsm).toHaveBeenCalledTimes(3);
    expect(sendSsm.mock.calls.map((call) => call[0].input.Name)).toEqual([
      'image',
      'version',
      'version',
    ]);
    expect(JSON.parse(sendMicrovm.mock.calls[0]?.[0].input.runHookPayload)).toMatchObject({
      runId: record.runId,
      traceId: record.runId,
    });
  });

  it('resumes an existing conversation MicroVM and posts the next bounded run', async () => {
    const sendMicrovm = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetMicrovmCommand':
          return Promise.resolve({
            microvmId: 'microvm-session-1',
            state: 'SUSPENDED',
            endpoint: 'session.lambda-microvm.us-east-1.on.aws',
          });
        case 'ResumeMicrovmCommand':
          return Promise.resolve({});
        case 'CreateMicrovmAuthTokenCommand':
          return Promise.resolve({ authToken: { 'X-aws-proxy-auth': 'proxy-token' } });
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    });
    const sendSsm = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
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
    const continuationRecord: RunRecord = {
      ...record,
      conversation: {
        conversationId: 'teams:tenant:user:thread',
        turnId: 'turn-1',
        slice: 1,
        preferredMicrovmId: 'microvm-session-1',
        agentThreadId: 'codex-thread-1',
      },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toEqual({ backend: 'microvm', id: 'microvm-session-1' });

    expect(sendSsm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://session.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-aws-proxy-auth': 'proxy-token',
          'x-aws-proxy-port': '8080',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      runHookPayload: string;
    };
    expect(JSON.parse(body.runHookPayload)).toMatchObject({
      persistentSession: true,
      agentThreadId: 'codex-thread-1',
    });
    vi.unstubAllGlobals();
  });

  it('mounts durable S3 Files state and resumes a Codex thread in a replacement MicroVM', async () => {
    const sendMicrovm = vi.fn().mockResolvedValue({ microvmId: 'microvm-replacement' });
    const sendSsm = vi.fn().mockImplementation((command: { input: { Name: string } }) =>
      Promise.resolve({ Parameter: { Value: command.input.Name === 'image' ? 'image-arn' : '4' } }),
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
        defaultAgentDriver: 'codex',
        allowAgentAwsCredentialChain: false,
        s3Files: {
          networkConnectorArn: 'arn:aws:lambda:us-east-1:account:network-connector:nc-1',
          fileSystemId: 'fs-1234',
          accessPointId: 'fsap-1234',
          mountTargetIp: '10.242.0.20',
        },
      },
    );
    const continuationRecord: RunRecord = {
      ...record,
      conversation: {
        conversationId: 'teams:tenant:user:thread',
        turnId: 'turn-2',
        slice: 2,
        agentThreadId: 'codex-thread-1',
      },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toEqual({ backend: 'microvm', id: 'microvm-replacement' });

    const input = sendMicrovm.mock.calls[0]?.[0].input;
    expect(input.egressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:account:network-connector:nc-1',
    ]);
    expect(JSON.parse(input.runHookPayload)).toMatchObject({
      persistentSession: true,
      agentThreadId: 'codex-thread-1',
      conversationStorageKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      s3FilesFileSystemId: 'fs-1234',
      s3FilesAccessPointId: 'fsap-1234',
      s3FilesMountTargetIp: '10.242.0.20',
    });
  });
});
