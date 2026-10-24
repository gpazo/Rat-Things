import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { createModelCatalog, modelCatalogFromConfig, modelCatalogFromResponse } from '../../src/core/model-catalog.js';
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

describe('Pi Bedrock catalog', () => {
  it('preserves exact IDs and deployment order with published model capabilities', async () => {
    const { piCatalog } = await import('../../src/adapters/pi-model-catalog.js');
    const { createPiModelCatalog } = await import('../../src/core/model-catalog.js');
    const models = piCatalog(['amazon.nova-micro-v1:0', 'us.anthropic.claude-sonnet-4-6'], 'us-west-2');
    expect(models.map(model => model.id)).toEqual(['amazon.nova-micro-v1:0', 'us.anthropic.claude-sonnet-4-6']);
    expect(models[0]).toMatchObject({ provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region: 'us-west-2', input: ['text'], reasoning: ['none'] });
    expect(models[1]).toMatchObject({ input: ['text', 'image'], reasoning: ['low', 'medium', 'high'] });
    expect(createPiModelCatalog(models, models[1]!.id)).toMatchObject({ runtime: 'pi', default_model: 'us.anthropic.claude-sonnet-4-6', capabilities: { environments: ['none', 'openai_hosted'], tools: ['function', 'mcp'], programmatic_tool_calling: false } });
    expect(createPiModelCatalog(models, 'other')).toBeUndefined();
  });

  it('rejects registry labels that lack supported Converse inference and reasoning', async () => {
    const { piCatalog, piCatalogFromConfig, piRegistryModel } = await import('../../src/adapters/pi-model-catalog.js');
    for (const id of ['openai.gpt-5.5', 'openai.gpt-5.4', 'google.gemma-4-31b', 'xai.grok-4.3', 'unknown']) {
      expect(() => piCatalog([id], 'us-west-2')).toThrow('Unsupported Pi Converse model');
    }
    expect(piRegistryModel('us.openai.gpt-5.4')).toMatchObject({ id: 'us.openai.gpt-5.4', api: 'bedrock-converse-stream' });
    expect(piCatalog(['global.openai.gpt-5.4'], 'us-west-2')[0]).toMatchObject({ id: 'global.openai.gpt-5.4', reasoning: ['low', 'medium', 'high', 'xhigh'] });
    expect(piCatalogFromConfig(undefined, undefined)).toEqual([]);
    expect(() => piCatalogFromConfig('{}', 'us-west-2')).toThrow('JSON array');
    expect(() => piCatalog(['amazon.nova-micro-v1:0'], '')).toThrow('AWS_REGION');
    expect(() => piCatalog(['amazon.nova-micro-v1:0', 'amazon.nova-micro-v1:0'], 'us-west-2')).toThrow('duplicates');
  });
});

it('preserves exact destination choices and discards unrelated response fields', () => {
  const source = { object: 'list', data: [{ id: 'provider/model', object: 'model', display_name: 'Model', private: 'discard' },
    { id: 'other', object: 'model' }], default_model: 'other', extra: 'discard' };
  expect(modelCatalogFromResponse(source)).toEqual({ object: 'list', data: [{ id: 'provider/model', object: 'model', display_name: 'Model' },
    { id: 'other', object: 'model' }], default_model: 'other' });
  expect(source.data[0]?.private).toBe('discard');
});

it('rejects unusable destination catalogs without repairing or selecting their IDs', () => {
  const model = { id: 'exact', object: 'model' };
  for (const value of [null, [], {}, { object: 'wrong', data: [model] }, { object: 'list', data: [] },
    ...[null, {}, { ...model, object: 'wrong' }, { ...model, id: '' }, { ...model, id: ' padded ' },
      { ...model, id: 'control\n' }, { ...model, id: 'x'.repeat(513) }, { ...model, display_name: 1 },
      { ...model, display_name: 'x'.repeat(257) }, { ...model, display_name: 'bad\u007f' }]
      .map(item => ({ object: 'list', data: [item] })),
    { object: 'list', data: [model, model] }, { object: 'list', data: [model], default_model: 'missing' },
    { object: 'list', data: [model], default_model: null },
    { object: 'list', data: Array.from({ length: 1001 }, (_, index) => ({ ...model, id: `m${index}` })) },
  ]) expect(modelCatalogFromResponse(value)).toBeUndefined();
});
