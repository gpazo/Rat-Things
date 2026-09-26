import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentRequest } from '../../src/lambdas/agents-router.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { MemoryAgentsStore } from './fixtures.js';

function fixture() {
  let nextId = 0;
  let now = 1_800_000_000;
  const store = new MemoryAgentsStore();
  const service = new AgentService({
    store,
    ids: { next: (prefix) => `${prefix}_${String(++nextId).padStart(6, '0')}` },
    clock: { now: () => now++ },
  });
  const requests: Request[] = [];
  const client = (ownerId: string) => new OpenAI({
    apiKey: 'test-only', baseURL: 'https://rat.invalid/v1', maxRetries: 0,
    fetch: async (url, options) => {
      const request = new Request(url, options);
      requests.push(request.clone());
      return routeAgentRequest(request, iamApiPrincipal(ownerId), service, 'request-1');
    },
  });
  return { store, service, requests, alice: client('alice'), bob: client('bob') };
}

describe('OpenAI SDK Agents API conformance', () => {
  it('creates, retrieves, updates, pages, and deletes through the unmodified SDK', async () => {
    const { alice, requests } = fixture();
    const first = await alice.beta.agents.create({ model: 'requested-model', name: 'First' });
    const second = await alice.beta.agents.create({ model: 'another-model', name: 'Second' });
    expect(parseAgentsContract('Agent', first)).toMatchObject({
      object: 'agent', model: 'requested-model', name: 'First', metadata: {},
      instructions: null, tools: [], created_at: expect.any(Number), updated_at: expect.any(Number),
    });
    expect(await alice.beta.agents.retrieve(first.id)).toEqual(first);
    const updated = await alice.beta.agents.update(first.id, { name: null, instructions: 'Use precise sources.' });
    expect(updated).toMatchObject({ id: first.id, model: 'requested-model', name: null, instructions: 'Use precise sources.' });
    expect(updated.updated_at).toBeGreaterThan(first.updated_at);
    const ids: string[] = [];
    for await (const agent of alice.beta.agents.list({ limit: 1, order: 'asc' })) ids.push(agent.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(await alice.beta.agents.delete(first.id)).toEqual({ id: first.id, object: 'agent.deleted', deleted: true });
    await expect(alice.beta.agents.retrieve(first.id)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    expect(requests.every((request) => request.headers.get('openai-beta') === 'agents=v1')).toBe(true);
    expect(requests.some((request) => request.method === 'POST' && request.url.endsWith(`/${first.id}`))).toBe(true);
  });

  it('replaces supplied objects and arrays and clears nullable settings', async () => {
    const { alice } = fixture();
    const created = await alice.beta.agents.create({
      model: 'pinned-model', metadata: { original: 'value' },
      reasoning: { effort: 'high', summary: 'detailed' },
      multi_agent: { enabled: true, max_concurrent_subagents: 2 },
      text: { format: { type: 'json_schema', schema: { type: 'object' } }, verbosity: 'high' },
      tools: [{ type: 'web_search', mode: 'cached' }],
    });
    const updated = await alice.beta.agents.update(created.id, {
      reasoning: { summary: 'auto' }, text: { verbosity: 'low' },
      multi_agent: { enabled: false }, tools: [], metadata: null,
    });
    expect(updated).toMatchObject({
      model: 'pinned-model', metadata: {}, tools: [],
      reasoning: { effort: null, summary: 'auto' },
      text: { format: { type: 'text' }, verbosity: 'low' },
      multi_agent: { enabled: false, max_concurrent_subagents: null },
    });
    parseAgentsContract('Agent', updated);
  });

  it('resolves disabled subagent capacity to null and resets enabled capacity to six', async () => {
    const { alice } = fixture();
    const agent = await alice.beta.agents.create({ model: 'model' });
    expect(agent.multi_agent).toEqual({ enabled: false, max_concurrent_subagents: null });
    const enabled = await alice.beta.agents.update(agent.id, { multi_agent: { enabled: true } });
    expect(enabled.multi_agent).toEqual({ enabled: true, max_concurrent_subagents: 6 });
    const disabled = await alice.beta.agents.update(agent.id, { multi_agent: { enabled: false, max_concurrent_subagents: 2 } });
    expect(disabled.multi_agent).toEqual({ enabled: false, max_concurrent_subagents: null });
    const unchanged = await alice.beta.agents.update(agent.id, { instructions: 'Preserve omitted fields.' });
    expect(unchanged.multi_agent).toEqual(disabled.multi_agent);
    const reset = await alice.beta.agents.update(agent.id, { multi_agent: null });
    expect(reset.multi_agent).toEqual(agent.multi_agent);
  });

  it('resolves the pinned model reasoning default and preserves explicit effort', async () => {
    const { alice } = fixture();
    const agent = await alice.beta.agents.create({ model: 'gpt-6-astra' });
    expect(agent.reasoning).toEqual({ effort: 'low', summary: null });
    const explicit = await alice.beta.agents.update(agent.id, { reasoning: { effort: 'high' } });
    expect(explicit.reasoning.effort).toBe('high');
    const replaced = await alice.beta.agents.update(agent.id, { reasoning: { summary: 'auto' } });
    expect(replaced.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    const reset = await alice.beta.agents.update(agent.id, { reasoning: null });
    expect(reset.reasoning).toEqual(agent.reasoning);
    expect((await alice.beta.agents.create({ model: 'gpt-5.4' })).reasoning.effort).toBe('medium');
  });

  it('isolates owners on reads, updates, deletes, and pagination cursors', async () => {
    const { alice, bob } = fixture();
    const agent = await alice.beta.agents.create({ model: 'model' });
    await expect(bob.beta.agents.retrieve(agent.id)).rejects.toMatchObject({ status: 404 });
    await expect(bob.beta.agents.update(agent.id, { instructions: 'overwrite' })).rejects.toMatchObject({ status: 404 });
    await expect(bob.beta.agents.delete(agent.id)).rejects.toMatchObject({ status: 404 });
    await expect(bob.beta.agents.list({ after: agent.id })).rejects.toMatchObject({ status: 400, param: 'after' });
    expect((await bob.beta.agents.list()).data).toEqual([]);
  });

  it('returns standard errors for old contracts, malformed requests, and secret-bearing saved agents', async () => {
    const { service, alice } = fixture();
    const send = (body: unknown) => routeAgentRequest(new Request('https://rat.invalid/v1/agents', {
      method: 'POST', body: JSON.stringify(body),
    }), iamApiPrincipal('alice'), service);
    for (const body of [
      { version: '1', name: 'old', goal: 'old', trigger: { kind: 'manual' } },
      { model: 'model', ownerId: 'bob' },
      { model: 'model', reasoning: { effort: 'invented' } },
      { model: 'model', multi_agent: { enabled: true, max_concurrent_subagents: 0 } },
      { model: 'model', tools: [{ type: 'mcp', server_label: 'private', transport: { type: 'http', server_url: 'https://mcp.example', authorization: 'secret' } }] },
      { model: 'model', tools: [{ type: 'mcp', server_label: 'private', transport: { type: 'http', server_url: 'https://mcp.example', headers: { Authorization: 'secret' } } }] },
    ]) {
      const response = await send(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_request' } });
    }
    await expect(alice.beta.agents.create({ model: 'model', metadata: { key: 'x'.repeat(513) } }))
      .rejects.toMatchObject({ status: 400, param: 'metadata' });
    expect((await alice.beta.agents.list()).data).toEqual([]);
  });

  it('validates upstream session inputs, stream events, and the full primitive catalogue', () => {
    expect(parseAgentsContract('SessionCreate', {
      agent: { model: 'model' }, environment: { type: 'self_hosted', workspace_directory: '/workspace' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }], stream: true,
    })).toBeDefined();
    expect(parseAgentsContract('SessionEvents', {
      events: [{ type: 'agent.session.input.cancel' }],
    })).toBeDefined();
    expect(() => parseAgentsContract('SessionEvents', {
      events: [{ type: 'agent.session.input.message', prompt: 'old prompt field' }],
    })).toThrow();
    expect(parseAgentsContract('VaultCreate', { name: 'Private tools' })).toBeDefined();
    expect(parseAgentsContract('EnvironmentTemplateCreate', {
      network: { access: 'restricted', allowed_domains: ['example.com'] },
    })).toBeDefined();
  });
});
