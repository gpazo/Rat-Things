import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAwsClientConfig,
  createAwsClients,
  S3ArtifactStore,
  S3PublicationObjectStore,
} from '../../src/adapters/aws-runtime.js';

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
