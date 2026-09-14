import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import type { AgentToolParam } from '../../src/domain/agents-api.js';
import type { SessionToolSecret } from '../../src/credentials/session-tools.js';
import { MemoryAgentsStore } from './fixtures.js';
import { integrationFixture } from './integration-fixtures.js';

function toolFixture(store = new MemoryAgentsStore()) {
  const values = new Map<string, SessionToolSecret>();
  const secrets = {
    reference: vi.fn(() => 'secret-1'),
    create: vi.fn(async (value: SessionToolSecret, id: string) => {
      values.set(id, structuredClone(value));
    }),
    revoke: vi.fn(async (id: string) => { values.delete(id); }),
  };
  const vaults = new VaultService({ store, secrets: {
    create: async () => { throw new Error('No vault credentials'); },
    read: async () => { throw new Error('No vault credentials'); }, revoke: async () => {},
  } });
  const service = new SessionToolService({ store, secrets, vaults, clock: { now: () => 100 } });
  const tools: AgentToolParam[] = [{ type: 'mcp', server_label: 'crm', transport: {
    type: 'http', server_url: 'https://crm.example/mcp', authorization: 'Bearer inline-only',
  } }];
  const agent = sessionAgent({ model: 'test', tools }, 'agent_test', 100);
  return { store, secrets, values, service, tools, agent };
}

describe('Session preparation recovery', () => {
  it('rejects changed retry input before repeating preparation effects', async () => {
    const f = await integrationFixture();
    const input = { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Original' };
    const prepare = vi.fn(f.execution.prepare);
    prepare.mockRejectedValueOnce(new Error('Interrupted'));
    f.execution.prepare = prepare;
    await expect(f.sessions.create('operator', input, 'sess_pending')).rejects.toThrow('Interrupted');
    await expect(f.sessions.create('operator', { ...input, input: 'Changed' }, 'sess_pending')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(prepare).toHaveBeenCalledTimes(1);
    await f.sessions.create('operator', input, 'sess_pending');
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('resumes concurrent creators from the winning snapshot', async () => {
    const f = await integrationFixture();
    const input = { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Original' };
    const [one, two] = await Promise.all([
      f.sessions.create('operator', input, 'sess_concurrent'),
      f.sessions.create('operator', input, 'sess_concurrent'),
    ]);
    expect(two).toEqual(one);
    expect((await f.sessions.turns('operator', one.id)).data).toHaveLength(1);
    await f.sessions.dispatch('operator', one.id);
    expect(f.execution.start).toHaveBeenCalledTimes(1);
  });

  it('does not store inline authorization in the durable preparation snapshot', async () => {
    const f = await integrationFixture();
    const t = toolFixture(f.store);
    f.execution.prepare = async (owner, id, environment, agent, vaults, tools = [], resume) => {
      await t.service.prepare(owner, id, agent, tools, vaults, resume);
      if (environment.type !== 'none') throw new Error('Expected no environment');
      return environment;
    };
    await f.sessions.create('operator', { agent: { model: 'test', tools: t.tools }, environment: { type: 'none' }, input: 'Start' }, 'sess_inline');
    expect([...t.values.values()][0]?.headers.Authorization).toBe('Bearer inline-only');
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('inline-only');
  });

  it('fails closed for a legacy MCP snapshot whose original transport is unavailable', async () => {
    const f = await integrationFixture();
    const t = toolFixture();
    await f.store.put({ ownerId: 'operator', id: 'sess_legacy', collection: 'session_preparations', createdAt: 100, revision: 1, value: { agent: t.agent, now: 100 } }, 0);
    const prepare = vi.fn(f.execution.prepare);
    f.execution.prepare = prepare;
    await expect(f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Original' }, 'sess_legacy'))
      .rejects.toMatchObject({ code: 'session_preparation_incomplete' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('preserves saved MCP headers and configuration after interrupted setup and Agent deletion', async () => {
    const f = await integrationFixture();
    const agents = new AgentService({ store: f.store });
    await agents.update('operator', f.agent.id, { tools: [{ type: 'mcp', server_label: 'crm',
      transport: { type: 'http', server_url: 'https://crm.example/mcp', headers: { 'X-Tenant': 'original' } },
    }] });
    const t = toolFixture(f.store);
    let attempts = 0;
    f.execution.prepare = async (owner, id, environment, agent, vaults, tools = [], resume) => {
      if (++attempts === 1) throw new Error('Environment setup interrupted');
      await t.service.prepare(owner, id, agent, tools, vaults, resume);
      if (environment.type !== 'none') throw new Error('Expected no environment');
      return environment;
    };
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await expect(f.integrations.submitPending('operator', sessionId)).rejects.toThrow('setup interrupted');
    await agents.delete('operator', f.agent.id);
    await f.integrations.submitPending('operator', sessionId);
    const session = await f.sessions.retrieve('operator', sessionId);
    expect(session.agent.tools).toMatchObject([{ type: 'mcp', server_label: 'crm' }]);
    expect(JSON.stringify(session)).not.toContain('X-Tenant');
    expect([...t.values.values()]).toMatchObject([{ headers: { 'X-Tenant': 'original' } }]);
    await f.integrations.submitPending('operator', sessionId);
    expect(t.secrets.create).toHaveBeenCalledTimes(1);
    expect((await f.sessions.turns('operator', sessionId)).data).toHaveLength(1);
  });

  it.each(['snapshot', 'session'] as const)('recovers a lost %s commit acknowledgement without repeating execution', async (stage) => {
    const f = await integrationFixture();
    const commit = f.store.commit.bind(f.store);
    let interrupted = false;
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      await commit(writes);
      if (!interrupted && writes.some(({ resource }) => resource.collection === (stage === 'snapshot' ? 'session_preparations' : 'sessions'))) {
        interrupted = true;
        throw new Error('Lost commit acknowledgement');
      }
    });
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    expect(interrupted).toBe(true);
    expect(f.execution.start).toHaveBeenCalledTimes(1);
    expect((await f.sessions.turns('operator', sessionId)).data).toHaveLength(1);
  });
});

describe('MCP binding commit recovery', () => {
  it('validates every transport before reading vault credentials or creating secrets', async () => {
    const f = toolFixture();
    const invalidTools: AgentToolParam[] = [f.tools[0]!, { type: 'mcp', server_label: 'invalid', transport: {
      type: 'http', server_url: 'https://invalid.example/mcp', authorization: 'one', headers: { authorization: 'two' },
    } }];
    const agent = sessionAgent({ model: 'test', tools: invalidTools }, 'agent_test', 100);
    const vaults = { requireVaults: vi.fn(async () => {}), resolve: vi.fn(async () => { throw new Error('Unexpected credential access'); }) };
    const service = new SessionToolService({ store: f.store, secrets: f.secrets, vaults });
    const before = structuredClone(invalidTools);
    await expect(service.prepare('alice', 'sess_invalid', agent, invalidTools, []))
      .rejects.toMatchObject({ code: 'invalid_request', param: 'agent.tools.transport' });
    expect(vaults.requireVaults).not.toHaveBeenCalled();
    expect(vaults.resolve).not.toHaveBeenCalled();
    expect(f.secrets.create).not.toHaveBeenCalled();
    expect(invalidTools).toEqual(before);
  });

  it.each(['timeout', 'conflict'] as const)('preserves adopted secrets after a committed write reports %s', async (failure) => {
    const f = toolFixture();
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      await commit(writes);
      if (!writes.some(({ resource }) => resource.collection === 'session_tools')) return;
      throw failure === 'conflict' ? new AgentsApiError(409, 'Retry saw existing revision', 'conflict') : new Error('Lost acknowledgement');
    });
    await f.service.prepare('alice', 'sess_test', f.agent, f.tools, [], true);
    expect((await f.store.get('alice', 'session_tools', 'sess_test'))?.value).toEqual([{ serverLabel: 'crm', inlineReference: 'secret-1' }]);
    expect(f.values.get('secret-1')?.headers.Authorization).toBe('Bearer inline-only');
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    await f.service.prepare('alice', 'sess_test', f.agent, f.tools, [], true);
    expect(f.secrets.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('inline-only');
  });

  it('discards only this attempt’s secrets when another preparation wins', async () => {
    const f = toolFixture();
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      const binding = writes.find(({ resource }) => resource.collection === 'session_tools');
      if (!binding) return commit(writes);
      await commit([{ ...binding, resource: { ...binding.resource, value: [{ serverLabel: 'crm', inlineReference: 'winner-secret' }] } }]);
      throw new AgentsApiError(409, 'Concurrent preparation', 'conflict');
    });
    await f.service.prepare('alice', 'sess_test', f.agent, f.tools, [], true);
    expect(f.secrets.revoke.mock.calls).toEqual([['secret-1']]);
    expect((await f.store.get('alice', 'session_tools', 'sess_test'))?.value).toEqual([{ serverLabel: 'crm', inlineReference: 'winner-secret' }]);
  });

  it.each([false, true])('creates no secret after an uncertain intent write (read fails: %s)', async (readFails) => {
    const f = toolFixture();
    const failure = new Error('Commit outcome unknown');
    vi.spyOn(f.store, 'put').mockRejectedValue(failure);
    // The initial preparation read succeeds; storage becomes unavailable only
    // after the uncertain intent write.
    if (readFails) vi.spyOn(f.store, 'get').mockRejectedValue(new Error('Read unavailable')).mockResolvedValueOnce(undefined);
    await expect(f.service.prepare('alice', 'sess_test', f.agent, f.tools, [])).rejects.toBe(failure);
    expect(f.secrets.create).not.toHaveBeenCalled();
    expect(f.secrets.revoke).not.toHaveBeenCalled();
  });
});
