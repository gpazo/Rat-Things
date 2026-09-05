import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAwsClientConfig,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3PublicationObjectStore,
} from '../../src/adapters/aws-runtime.js';
import type { AgentToolCallRecord } from '../../src/domain/interaction.js';

describe('AWS runtime client configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the LocalStack endpoint and path-style S3 addressing when configured', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:4566');
    vi.stubEnv('AWS_S3_FORCE_PATH_STYLE', 'true');

    expect(createAwsClientConfig('us-east-1')).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
    });
    const clients = createAwsClients('us-east-1');
    const pathStyle = clients.s3.config.forcePathStyle as unknown;
    const resolvedPathStyle = typeof pathStyle === 'function'
      ? await (pathStyle as () => Promise<boolean>)()
      : pathStyle;
    expect(resolvedPathStyle).toBe(true);
    clients.s3.destroy();
    clients.sqs.destroy();
    clients.events.destroy();
    clients.secrets.destroy();
  });

  it('does not install a custom endpoint for AWS deployments', () => {
    vi.stubEnv('AWS_ENDPOINT_URL', '');
    expect(createAwsClientConfig('us-west-2')).toEqual({ region: 'us-west-2' });
  });

  it('joins generated execution attachment conditions with valid boolean operators', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      return {
      Attributes: {
        runId: 'run-1',
        status: 'dispatching',
      },
      };
    });
    const store = new DynamoRunStore(
      { send } as unknown as DynamoDBDocumentClient,
      'runs',
    );

    await store.attachExecution('run-1', {
      backend: 'microvm',
      id: 'microvm-1',
      generation: 'generation-1',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input.ConditionExpression).toBe(
      'attribute_exists(runId) AND #status IN (:dispatching, :running) AND (attribute_not_exists(#execution) OR (#execution.#id = :pending AND (attribute_not_exists(#execution.#generation) OR #execution.#generation = :generation)))',
    );
  });

  it('treats an exact execution attachment won by another delivery as idempotent', async () => {
    const attached = {
      runId: 'run-1',
      status: 'running' as const,
      execution: {
        backend: 'microvm' as const,
        id: 'microvm-1',
        generation: 'generation-1',
        startedAt: '2026-01-01T00:00:01.000Z',
      },
    };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateCommand) {
        throw Object.assign(new Error('conditional check failed'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      if (command instanceof GetCommand) return { Item: attached };
      throw new Error('unexpected command');
    });
    const store = new DynamoRunStore(
      { send } as unknown as DynamoDBDocumentClient,
      'runs',
    );

    await expect(store.attachExecution('run-1', {
      backend: 'microvm',
      id: 'microvm-1',
      generation: 'generation-1',
    })).resolves.toBe(attached);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('persists and settles a bounded exact-generation dynamic tool record', async () => {
    const generation = 'a'.repeat(64);
    const pending = {
      version: '1' as const,
      runId: 'run-tool',
      requestId: 'request-1',
      method: 'item/tool/call' as const,
      executionId: 'microvm-tool',
      executionGeneration: generation,
      namespace: 'fixture_crm',
      tool: 'records_create',
      argumentDigest: 'b'.repeat(64),
      admittedToolsDigest: 'c'.repeat(64),
      status: 'pending' as const,
      startedAt: '2026-08-24T21:00:00.000Z',
    };
    let currentCalls: AgentToolCallRecord[] | undefined;
    const commands: UpdateCommand[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return {
        Item: {
          runId: 'run-tool',
          status: 'running',
          execution: { backend: 'microvm', id: 'microvm-tool', generation },
          ...(currentCalls ? { agentToolCalls: currentCalls } : {}),
        },
      };
      if (command instanceof UpdateCommand) {
        commands.push(command);
        currentCalls = command.input.ExpressionAttributeValues?.[':next'] as AgentToolCallRecord[];
        return {};
      }
      throw new Error('unexpected command');
    });
    const store = new DynamoRunStore(
      { send } as unknown as DynamoDBDocumentClient,
      'runs',
    );

    await expect(store.beginAgentToolCall(pending)).resolves.toEqual(pending);
    await expect(store.settleAgentToolCall({
      runId: 'run-tool',
      execution: { backend: 'microvm', id: 'microvm-tool', generation },
      requestId: 'request-1',
      status: 'succeeded',
      settledAt: '2026-08-24T21:00:01.000Z',
      resultDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ status: 'succeeded', resultDigest: 'd'.repeat(64) });

    expect(commands).toHaveLength(2);
    expect(commands[0]?.input.ConditionExpression).toContain('attribute_not_exists(#agentToolCalls)');
    expect(commands[0]?.input.ExpressionAttributeValues).not.toHaveProperty(':current');
    expect(commands[1]?.input.ExpressionAttributeValues).toHaveProperty(':current');
    expect(commands[1]?.input.ExpressionAttributeValues?.[':next']).toEqual([
      expect.objectContaining({ requestId: 'request-1', status: 'succeeded' }),
    ]);
  });

  it('fences terminal artifacts and refuses a stale worker generation', async () => {
    const execution = {backend: 'microvm' as const, id: 'microvm-1', generation: 'generation-1'};
    const result = {output: {bucket: 'artifacts', key: 'partial', sha256: 'a'.repeat(64)}, preview: 'Stopped', durationMs: 10, exitCode: 0};
    let generation = execution.generation;
    let update: UpdateCommand | undefined;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return {Item: {runId: 'run-1', status: 'running', execution: {...execution, generation}}};
      if (command instanceof UpdateCommand) { update = command; return {}; }
      throw new Error('unexpected command');
    });
    const store = new DynamoRunStore({send} as unknown as DynamoDBDocumentClient, 'runs');
    expect(await store.finishExecution('run-1', execution, 'cancelled', result)).toBe(true);
    expect(update?.input.ConditionExpression).toContain('#execution.#generation = :generation');
    expect(update?.input.ExpressionAttributeValues?.[':result']).toEqual(result);
    generation = 'replacement-generation';
    update = undefined;
    expect(await store.finishExecution('run-1', execution, 'cancelled', result)).toBe(false);
    expect(update).toBeUndefined();
  });

  it('atomically interrupts pending tool calls when an exact execution is failed', async () => {
    const generation = 'e'.repeat(64);
    const pending = {
      version: '1' as const,
      runId: 'run-lost',
      requestId: 'request-lost',
      method: 'item/tool/call' as const,
      executionId: 'microvm-lost',
      executionGeneration: generation,
      namespace: 'fixture_crm',
      tool: 'records_create',
      argumentDigest: 'f'.repeat(64),
      admittedToolsDigest: '1'.repeat(64),
      status: 'pending' as const,
      startedAt: '2026-08-24T21:00:00.000Z',
    };
    let update: UpdateCommand | undefined;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return {
        Item: {
          runId: 'run-lost',
          status: 'running',
          heartbeatAt: '2026-08-24T21:00:02.000Z',
          execution: { backend: 'microvm', id: 'microvm-lost', generation },
          agentToolCalls: [pending],
        },
      };
      if (command instanceof UpdateCommand) {
        update = command;
        return {};
      }
      throw new Error('unexpected command');
    });
    const store = new DynamoRunStore(
      { send } as unknown as DynamoDBDocumentClient,
      'runs',
    );

    await expect(store.failExecution(
      'run-lost',
      { backend: 'microvm', id: 'microvm-lost', generation },
      '2026-08-24T21:00:02.000Z',
      { code: 'execution_lost', message: 'MicroVM terminated', retryable: true },
    )).resolves.toBe(true);

    expect(update?.input.UpdateExpression).toContain('#agentToolCalls = :nextCalls');
    expect(update?.input.ExpressionAttributeValues?.[':nextCalls']).toEqual([
      expect.objectContaining({
        requestId: 'request-lost',
        status: 'interrupted',
        error: expect.stringContaining('must not be replayed automatically'),
      }),
    ]);
  });

  it('streams artifacts through multipart upload and renews unchanged objects with CopyObject', async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
        if (command instanceof UploadPartCommand) return { ETag: '"etag-1"' };
        return {};
      }),
    } as unknown as S3Client;
    const store = new S3ArtifactStore(client, 'artifact-bucket');
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 3, 0xab);
    const uploaded = await store.putStream(
      'owners/abc/runs/run-1/video.mp4',
      (async function* () {
        yield bytes.subarray(0, 1024 * 1024);
        yield bytes.subarray(1024 * 1024);
      })(),
      'video/mp4',
    );

    expect(commands.map((command) => (command as object).constructor)).toEqual([
      CreateMultipartUploadCommand,
      UploadPartCommand,
      UploadPartCommand,
      CompleteMultipartUploadCommand,
    ]);
    expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/);

    const renewed = await store.copy(
      uploaded,
      'owners/abc/runs/run-2/video.mp4',
      'video/mp4',
    );
    expect(commands.at(-1)).toBeInstanceOf(CopyObjectCommand);
    expect(renewed).toEqual({
      bucket: 'artifact-bucket',
      key: 'owners/abc/runs/run-2/video.mp4',
      sha256: uploaded.sha256,
    });
  });

  it('preserves the upload error when S3 reports that its cleanup already completed', async () => {
    const uploadError = new Error('part upload failed');
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
        if (command instanceof UploadPartCommand) throw uploadError;
        if (command instanceof AbortMultipartUploadCommand) {
          throw Object.assign(new Error('upload is absent'), { name: 'NoSuchUpload' });
        }
        return {};
      }),
    } as unknown as S3Client;
    const store = new S3ArtifactStore(client, 'artifact-bucket');

    await expect(store.putStream(
      'owners/abc/runs/run-1/video.mp4',
      (async function* () { yield Buffer.alloc(8 * 1024 * 1024); })(),
      'video/mp4',
    )).rejects.toBe(uploadError);
  });

  it('does not add an application retry when empty-stream cleanup fails', async () => {
    const cleanupError = new Error('S3 unavailable');
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
      if (command instanceof AbortMultipartUploadCommand) throw cleanupError;
      return {};
    });
    const store = new S3ArtifactStore(
      { send } as unknown as S3Client,
      'artifact-bucket',
    );

    await expect(store.putStream(
      'owners/abc/runs/run-1/empty.bin',
      (async function* () { yield new Uint8Array(); })(),
      'application/octet-stream',
    )).rejects.toBe(cleanupError);
    expect(send.mock.calls.filter(([command]) => command instanceof AbortMultipartUploadCommand))
      .toHaveLength(1);
  });

  it('reports an exhausted multipart cleanup without masking the upload error', async () => {
    const uploadError = new Error('part upload failed');
    const metricLines: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation((line) => {
      metricLines.push(String(line));
    });
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
        if (command instanceof UploadPartCommand) throw uploadError;
        if (command instanceof AbortMultipartUploadCommand) throw new Error('S3 unavailable');
        return {};
      }),
    } as unknown as S3Client;
    const store = new S3ArtifactStore(client, 'artifact-bucket');
    try {
      await expect(store.putStream(
        'owners/abc/runs/run-1/video.mp4',
        (async function* () { yield Buffer.alloc(8 * 1024 * 1024); })(),
        'video/mp4',
      )).rejects.toBe(uploadError);
      expect(metricLines.map((line) => JSON.parse(line) as unknown)).toContainEqual(
        expect.objectContaining({ Component: 'artifact-store', CleanupFailure: 1 }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('uses the configured KMS key for immutable definition objects', async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        return {};
      }),
    } as unknown as S3Client;
    const store = new S3ArtifactStore(client, 'definition-bucket', {
      algorithm: 'aws:kms',
      kmsKeyId: 'arn:aws:kms:us-west-2:123456789012:key/key-1',
    });

    await store.putJson('owners/abc/things/thing-1/revision-1.json', { version: '1' });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'definition-bucket',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'arn:aws:kms:us-west-2:123456789012:key/key-1',
    });
  });

  it('treats SDK-shaped 404 objects as a missing publication manifest', async () => {
    const client = {
      send: vi.fn(async () => {
        throw { name: 'S3ServiceException', $metadata: { httpStatusCode: 404 } };
      }),
    } as unknown as S3Client;
    const store = new S3PublicationObjectStore(client, 'artifact-bucket');

    await expect(store.getCommitted({
      ownerId: 'owner-1',
      publicationId: 'a'.repeat(24),
    })).resolves.toBeUndefined();
  });

  it('treats S3 missing-key AccessDenied without ListBucket as a cache miss', async () => {
    const client = {
      send: vi.fn(async () => {
        throw { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
      }),
    } as unknown as S3Client;
    const store = new S3PublicationObjectStore(client, 'artifact-bucket');

    await expect(store.getCommitted({
      ownerId: 'owner-1',
      publicationId: 'b'.repeat(24),
    })).resolves.toBeUndefined();
  });
});
