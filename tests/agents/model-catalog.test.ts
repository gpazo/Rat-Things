import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { createModelCatalog, modelCatalogFromConfig } from '../../src/core/model-catalog.js';
import type { ApiScope } from '../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

describe('deployed model catalog', () => {
  const agents = new AgentService({ store: new MemoryAgentsStore() });
  const models = createModelCatalog({
    modelIds: ['openai.gpt-5.6-terra', 'provider/example-model'],
    defaultModel: 'openai.gpt-5.6-terra',
  });

  it('returns the exact configured order and provider-prefixed IDs', async () => {
    const response = await routeAgentsRequest(
      new Request('https://rat.invalid/v1/models'),
      { ownerId: 'alice', scopes: ['api.agents.read'] },
      { agents, models },
      'request-id',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-id');
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        { id: 'openai.gpt-5.6-terra', object: 'model' },
        { id: 'provider/example-model', object: 'model' },
      ],
      default_model: 'openai.gpt-5.6-terra',
    });
  });

  it('requires api.agents.read and rejects unsupported operations', async () => {
    const call = (method: string, scopes: ApiScope[]) => routeAgentsRequest(
      new Request('https://rat.invalid/v1/models', { method }),
      { ownerId: 'alice', scopes },
      { agents, models },
    );
    expect((await call('GET', ['api.agents.write'])).status).toBe(403);
    expect((await call('POST', ['api.agents.read'])).status).toBe(405);
  });

  it('returns 503 when deployment configuration is absent, empty, or invalid', async () => {
    for (const unavailable of [
      modelCatalogFromConfig(undefined),
      modelCatalogFromConfig('[]'),
      modelCatalogFromConfig('{'),
      modelCatalogFromConfig('{}'),
      modelCatalogFromConfig('[""]'),
      modelCatalogFromConfig('["model-a", "model-a"]'),
      modelCatalogFromConfig('["model-a"]', 'model-b'),
      { object: 'list' as const, data: [] },
    ]) {
      const response = await routeAgentsRequest(
        new Request('https://rat.invalid/v1/models'),
        { ownerId: 'alice', scopes: ['api.agents.read'] },
        { agents, models: unavailable },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    }
  });
});
