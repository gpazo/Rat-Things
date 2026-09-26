import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';

describe('environment files through the standard SDK', () => {
  it('writes bytes, paginates live files, and fences owner, cursor, and path access', async () => {
    const store = new MemoryAgentsStore();
    const files = new Map<string, { path: string; size_bytes: number }>();
    const environments = new EnvironmentService({ store, relayURL: 'https://relay.example', credentials: {
      create: async () => 'secret', read: async () => ({ executor: '', harness: '' }), revoke: async () => {},
    }, fileOperations: { execute: async (_id, _reference, operation) => {
      if (operation.operation === 'list') return [...files.values()];
      if (operation.operation !== 'write') throw new Error('Unexpected file read');
      const result = { path: operation.path, size_bytes: Buffer.from(operation.data, 'base64').length };
      files.set(operation.path, result); return result;
    } } });
    const agents = new AgentService({ store });
    const api = (owner: string) => new OpenAI({ apiKey: 'test', maxRetries: 0, baseURL: 'https://rat.invalid/v1', fetch: (input, init) => routeAgentsRequest(new Request(input, init), iamApiPrincipal(owner), { agents, environments }) }).beta.agents.environments;
    const environment = await environments.prepare('alice', 'sess_test', { type: 'self_hosted', workspace_directory: '/workspace' });
    if (environment.type === 'none') throw new Error('Expected an environment');
    await environments.connection({ ownerId: 'alice', environmentId: environment.id, role: 'executor' }, 'registration', true);
    for (const name of ['a', 'b', 'c']) {
      const file = await api('alice').files.create(environment.id, { type: 'inline', path: `/workspace/${name}`, data: name === 'a' ? '' : 'AP+A' });
      parseAgentsContract('EnvironmentFile', file);
    }
    const first = await api('alice').files.list(environment.id, { limit: 1, order: 'asc' });
    expect(first.data[0]).toMatchObject({ path: '/workspace/a', size_bytes: 0 });
    expect((await first.getNextPage()).data[0]?.path).toBe('/workspace/b');
    const paths: string[] = [];
    for await (const file of api('alice').files.list(environment.id, { limit: 1, order: 'asc' })) paths.push(file.path);
    expect(paths).toEqual(['/workspace/a', '/workspace/b', '/workspace/c']);
    await expect(api('bob').files.list(environment.id)).rejects.toMatchObject({ status: 404 });
    await expect(api('alice').files.list(environment.id, { page: first.next!, order: 'desc' })).rejects.toMatchObject({ status: 400 });
    await expect(api('alice').files.create(environment.id, { type: 'inline', path: '/workspace/../outside', data: '' })).rejects.toMatchObject({ status: 400 });
    await environments.retire('alice', environment.id);
    await expect(api('alice').files.list(environment.id)).rejects.toMatchObject({ status: 404 });
  });
});
