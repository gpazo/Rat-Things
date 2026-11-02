import { expect, it } from 'vitest';
import { readSessionOutputSecrets } from '../../src/credentials/session-output.js';

it('reads only bound Session secrets and keeps snapshot identity checks before redaction', async () => {
  const values: Record<string, unknown> = {
    environment: { ownerId: 'alice', sessionId: 'session', environmentId: 'environment', credentials: [{ type: 'environment_variable', secret_name: 'SERVICE_TOKEN', secret_value: 'environment-secret', networking: { type: 'limited', allowed_hosts: ['example.com'] } }] },
    inline: { ownerId: 'alice', sessionId: 'session', serverLabel: 'crm', headers: { Authorization: 'Bearer inline-private-token' }, env: {} },
    vault: { type: 'static_bearer', mcp_server_url: 'https://example.com', token: 'vault-private-token' },
  };
  const reads: string[] = [];
  const reader = { get: async (reference: string) => { reads.push(reference); return JSON.stringify(values[reference]); } };
  const launch = { sessionId: 'session', environmentCredentials: { environmentId: 'environment', references: ['environment'] }, mcp: [{ serverLabel: 'crm', inlineReference: 'inline', vaultReference: 'vault' }] };
  expect(await readSessionOutputSecrets('alice', launch, reader)).toEqual(expect.arrayContaining(['environment-secret', 'inline-private-token', 'vault-private-token']));
  expect(reads.sort()).toEqual(['environment', 'inline', 'vault']);
  await expect(readSessionOutputSecrets('bob', launch, reader)).rejects.toThrow('identity');
});
