import { createServer } from 'node:http';
import { once } from 'node:events';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it, vi } from 'vitest';
import { createAwsClients } from '../../src/adapters/aws-runtime.js';

it('aborts a stalled worker authority read instead of only logging a timeout', async () => {
  const server = createServer(() => { /* Deliberately leave the response pending. */ });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  vi.stubEnv('AWS_ENDPOINT_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('AWS_SESSION_TOKEN', 'test');
  const clients = createAwsClients('us-east-1', { operationTimeoutMs: 20 });
  try {
    await expect(clients.dynamodb.send(new GetCommand({ TableName: 'runs', Key: { runId: 'test' } }))).rejects.toMatchObject({ name: 'TimeoutError' });
  } finally {
    for (const client of Object.values(clients)) client.destroy();
    vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
