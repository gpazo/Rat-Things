import { createHash } from 'node:crypto';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { SSMClient } from '@aws-sdk/client-ssm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentInteractionUnavailableError,
  MicrovmAgentInteractionController,
  MicrovmRunExecutor,
  workerOptionsFromEnv,
} from '../../src/adapters/executors.js';
import { runHookPayload } from '../../src/adapters/worker-launch.js';
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

afterEach(() => vi.unstubAllEnvs());

it('prepares EC2 Session mounts without a Lambda connector and rejects that configuration for MicroVM launch', async () => {
  for (const [name, value] of Object.entries({
    AWS_REGION: 'us-west-2', RUNS_TABLE_NAME: 'runs', INTEGRATIONS_TABLE_NAME: 'integrations',
    ARTIFACT_BUCKET: 'artifacts', EVENT_BUS_NAME: 'events', S3_FILES_ENABLED: 'true',
    S3_FILES_FILE_SYSTEM_ID: 'fs-state', S3_FILES_ACCESS_POINT_ID: 'fsap-state', S3_FILES_MOUNT_TARGET_IP: '10.0.0.2',
  })) vi.stubEnv(name, value);
  vi.stubEnv('MICROVM_VPC_NETWORK_CONNECTOR_ARN', undefined);
  const options = workerOptionsFromEnv();
  expect(options.s3Files).not.toHaveProperty('networkConnectorArn');
  const sessionRecord = { ...record, agentsSession: { sessionId: 'sess_ec2', turnId: 'turn_1', launch: record.input } };
  expect(JSON.parse(runHookPayload(sessionRecord, request, options))).toMatchObject({
    persistentSession: true, s3FilesFileSystemId: 'fs-state', s3FilesAccessPointId: 'fsap-state', s3FilesMountTargetIp: '10.0.0.2',
  });
  const sendMicrovm = vi.fn();
  const sendSsm = vi.fn();
  const microvm = new MicrovmRunExecutor({ send: sendMicrovm } as unknown as LambdaMicrovmsClient,
    { send: sendSsm } as unknown as SSMClient, options);
  await expect(microvm.start(sessionRecord, request, 'trace')).rejects.toThrow('requires a network connector');
  expect(sendMicrovm).not.toHaveBeenCalled();
  expect(sendSsm).not.toHaveBeenCalled();
});

describe('executor idempotency', () => {
  it('keeps RunMicrovm input stable when a reconciler supplies a new trace ID', async () => {
    const sendMicrovm = vi.fn().mockResolvedValue({ microvmId: 'microvm-1' });
    const observeStartup = vi.fn();
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
        integrationsTableName: 'integrations',
        artifactBucket: 'artifacts',
        eventBusName: 'events',
        region: 'us-east-1',
        allowedRepositoryHosts: 'github.com,gitlab.com',
        allowedSandboxModes: 'read-only,workspace-write',
        codexAuthFileSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rat/codex',
        allowAgentAwsCredentialChain: false,
        onStartupObservation: observeStartup,
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
    expect(observeStartup).toHaveBeenCalledTimes(2);
    expect(observeStartup).toHaveBeenNthCalledWith(1, {
      mode: 'launch',
      outcome: 'succeeded',
      durationMs: expect.any(Number),
    });
    expect(JSON.parse(sendMicrovm.mock.calls[0]?.[0].input.runHookPayload)).toMatchObject({
      runId: record.runId,
      executionGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
      heartbeatIntervalMs: 15_000,
      traceId: record.runId,
      codexAuthFileSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rat/codex',
    });
    expect(sendMicrovm.mock.calls[0]?.[0].input.ingressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    ]);
  });

  it('mounts the owned Session state in a replacement MicroVM', async () => {
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
        integrationsTableName: 'integrations',
        artifactBucket: 'artifacts',
        eventBusName: 'events',
        region: 'us-east-1',
        allowedRepositoryHosts: 'github.com,gitlab.com',
        allowedSandboxModes: 'read-only,workspace-write',
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
      agentsSession: { sessionId: 'sess_1', turnId: 'turn_2', launch: record.input },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toMatchObject({
        backend: 'microvm',
        id: 'microvm-replacement',
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

    const input = sendMicrovm.mock.calls[0]?.[0].input;
    expect(input.egressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:account:network-connector:nc-1',
    ]);
    expect(JSON.parse(input.runHookPayload)).toMatchObject({
      persistentSession: true,
      sessionStorageKey: createHash('sha256').update(JSON.stringify([record.ownerId, 'sess_1'])).digest('hex'),
      s3FilesFileSystemId: 'fs-1234',
      s3FilesAccessPointId: 'fsap-1234',
      s3FilesMountTargetIp: '10.242.0.20',
    });
    expect(JSON.parse(input.runHookPayload)).not.toHaveProperty('agentThreadId');
    await executor.start({ ...continuationRecord, ownerId: 'another-owner' }, request, 'trace');
    await executor.start({ ...continuationRecord, agentsSession: { ...continuationRecord.agentsSession!, sessionId: 'sess_2' } }, request, 'trace');
    const storageKeys = sendMicrovm.mock.calls.map(([command]) => JSON.parse(command.input.runHookPayload).sessionStorageKey);
    expect(new Set(storageKeys).size).toBe(3);
  });
});

describe('live MicroVM agent interaction', () => {
  it.each(['RUNNING', 'SUSPENDED'])('uses an AWS-issued port token for interaction with a %s MicroVM', async (state) => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetMicrovmCommand') {
        return Promise.resolve({
          microvmId: 'microvm-live-1',
          state,
          endpoint: 'live.lambda-microvm.us-east-1.on.aws',
        });
      }
      if (command.constructor.name === 'CreateMicrovmAuthTokenCommand') {
        return Promise.resolve({ authToken: { 'X-aws-proxy-auth': 'live-token' } });
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const snapshot = {
      runId: record.runId,
      active: true,
      ready: true,
      nextSequence: 2,
      events: [{
        sequence: 1,
        occurredAt: '2026-08-20T00:00:00.000Z',
        method: 'turn/started',
        params: {},
      }],
      pendingRequests: [],
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      status: url.includes('/events?') ? 200 : 202,
      text: () => Promise.resolve(JSON.stringify(url.includes('/events?') ? snapshot : { ok: true })),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new MicrovmAgentInteractionController(
      { send } as unknown as LambdaMicrovmsClient,
    );
    const target = {
      runId: record.runId,
      turnId: 'turn_current',
      execution: { backend: 'microvm' as const, id: 'microvm-live-1' },
    };

    await expect(controller.events(target, 0, 25)).resolves.toEqual(snapshot);
    await controller.steer(target, 'Focus on the failing test.');
    await controller.respond(target, 'input-7', { answer: 'continue' });
    await controller.startSessionTurn(target, {
      id: 'turn_next', object: 'agent.session.turn', session_id: 'sess_1', agent_id: 'agent_1', subagent_id: null,
      status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null,
    }, [{ role: 'user', content: [{ type: 'input_text', text: 'Next turn' }] }]);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/events?after=0&limit=25`,
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/steer`,
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/requests/input-7/respond`,
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/session-start`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-aws-proxy-auth': 'live-token',
        'x-aws-proxy-port': '8080',
      }),
      body: JSON.stringify({ result: { answer: 'continue' } }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ turnId: 'turn_current', prompt: 'Focus on the failing test.' });
    vi.unstubAllGlobals();
  });

  it('reports a not-yet-ready MicroVM lifecycle proxy as temporarily unavailable', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetMicrovmCommand') {
        return Promise.resolve({
          microvmId: 'microvm-starting-1',
          state: 'RUNNING',
          endpoint: 'starting.lambda-microvm.us-east-1.on.aws',
        });
      }
      if (command.constructor.name === 'CreateMicrovmAuthTokenCommand') {
        return Promise.resolve({ authToken: { 'X-aws-proxy-auth': 'startup-token' } });
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve(''),
    }));
    const controller = new MicrovmAgentInteractionController(
      { send } as unknown as LambdaMicrovmsClient,
    );
    const target = {
      runId: record.runId,
      execution: { backend: 'microvm' as const, id: 'microvm-starting-1' },
    };

    await expect(controller.events(target)).rejects.toBeInstanceOf(
      AgentInteractionUnavailableError,
    );
    vi.unstubAllGlobals();
  });
});
