import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentInteractionUnavailableError,
  MicrovmAgentInteractionController,
  MicrovmRunExecutor,
} from '../../src/adapters/executors.js';
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
        defaultAgentDriver: 'mock',
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

  it('resumes an existing conversation MicroVM and posts the next bounded run', async () => {
    let getCount = 0;
    const sendMicrovm = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetMicrovmCommand':
          return Promise.resolve({
            microvmId: 'microvm-session-1',
            state: getCount++ === 0 ? 'SUSPENDED' : 'RUNNING',
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
        integrationsTableName: 'integrations',
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
      executionInput: {
        bucket: 'input-bucket',
        key: 'runs/prepared-conversation-input.json',
        sha256: 'c'.repeat(64),
      },
      conversation: {
        conversationId: 'teams:tenant:user:thread',
        turnId: 'turn-1',
        slice: 1,
        preferredMicrovmId: 'microvm-session-1',
        agentThreadId: 'codex-thread-1',
      },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toMatchObject({
        backend: 'microvm',
        id: 'microvm-session-1',
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

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
      inputBucket: 'input-bucket',
      inputKey: 'runs/prepared-conversation-input.json',
    });
    vi.unstubAllGlobals();
  });

  it('retries a transient proxy response while a resumed MicroVM becomes ready', async () => {
    let getCount = 0;
    const sendMicrovm = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetMicrovmCommand':
          return Promise.resolve({
            microvmId: 'microvm-session-1',
            state: getCount++ === 0 ? 'SUSPENDED' : 'RUNNING',
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    const executor = new MicrovmRunExecutor(
      { send: sendMicrovm } as unknown as LambdaMicrovmsClient,
      { send: vi.fn() } as unknown as SSMClient,
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
        defaultAgentDriver: 'mock',
        allowAgentAwsCredentialChain: false,
      },
    );
    const continuationRecord: RunRecord = {
      ...record,
      conversation: {
        conversationId: 'api:test-owner:cli',
        turnId: 'turn-2',
        slice: 2,
        preferredMicrovmId: 'microvm-session-1',
      },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toMatchObject({
        backend: 'microvm',
        id: 'microvm-session-1',
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
    vi.unstubAllGlobals();
  });

  it('launches a replacement when AWS terminates a MicroVM during resume', async () => {
    let getCount = 0;
    const observeStartup = vi.fn();
    const sendMicrovm = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetMicrovmCommand':
          return Promise.resolve({
            microvmId: 'microvm-session-1',
            state: getCount++ === 0 ? 'SUSPENDED' : 'TERMINATED',
            endpoint: 'session.lambda-microvm.us-east-1.on.aws',
          });
        case 'ResumeMicrovmCommand':
          return Promise.resolve({});
        case 'RunMicrovmCommand':
          return Promise.resolve({ microvmId: 'microvm-replacement' });
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    });
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
        defaultAgentDriver: 'mock',
        allowAgentAwsCredentialChain: false,
        onStartupObservation: observeStartup,
      },
    );
    const continuationRecord: RunRecord = {
      ...record,
      conversation: {
        conversationId: 'api:test-owner:cli',
        turnId: 'turn-3',
        slice: 3,
        preferredMicrovmId: 'microvm-session-1',
        agentThreadId: 'codex-thread-1',
      },
    };

    await expect(executor.start(continuationRecord, request, 'trace'))
      .resolves.toMatchObject({
        backend: 'microvm',
        id: 'microvm-replacement',
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

    expect(sendMicrovm.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'GetMicrovmCommand',
      'ResumeMicrovmCommand',
      'GetMicrovmCommand',
      'RunMicrovmCommand',
    ]);
    expect(sendSsm).toHaveBeenCalledTimes(2);
    expect(observeStartup).toHaveBeenCalledTimes(2);
    expect(observeStartup.mock.calls.map((call) => call[0])).toEqual([
      { mode: 'resume', outcome: 'fallback', durationMs: expect.any(Number) },
      { mode: 'launch', outcome: 'succeeded', durationMs: expect.any(Number) },
    ]);
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
        integrationsTableName: 'integrations',
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
      agentThreadId: 'codex-thread-1',
      conversationStorageKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      s3FilesFileSystemId: 'fs-1234',
      s3FilesAccessPointId: 'fsap-1234',
      s3FilesMountTargetIp: '10.242.0.20',
    });
  });
});

describe('live MicroVM agent interaction', () => {
  it('uses an AWS-issued port token for events, steering, and requested input', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetMicrovmCommand') {
        return Promise.resolve({
          microvmId: 'microvm-live-1',
          state: 'RUNNING',
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
      execution: { backend: 'microvm' as const, id: 'microvm-live-1' },
    };

    await expect(controller.events(target, 0, 25)).resolves.toEqual(snapshot);
    await controller.steer(target, 'Focus on the failing test.');
    await controller.respond(target, 'input-7', { answer: 'continue' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/events?after=0&limit=25`,
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/steer`,
      `https://live.lambda-microvm.us-east-1.on.aws/agent-runtime/v1/runs/${record.runId}/requests/input-7/respond`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-aws-proxy-auth': 'live-token',
        'x-aws-proxy-port': '8080',
      }),
      body: JSON.stringify({ result: { answer: 'continue' } }),
    }));
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
