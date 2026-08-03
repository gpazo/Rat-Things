import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsClientConfig, createAwsClients } from '../../src/adapters/aws-runtime.js';

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
});
