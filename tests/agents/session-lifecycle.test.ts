import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import type { SessionExecution, SessionTurnObservation } from '../../src/core/session-ports.js';
import type { AgentSession } from '../../src/domain/agents-api.js';
import { AgentsApiError, parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

function fixture() {
  const store = new MemoryAgentsStore();
  const calls: Array<{ type: string; turnId: string; input?: unknown }> = [];
  const observations = new Map<string, SessionTurnObservation>();
  const seen = new Set<string>();
  const execution: SessionExecution = {
    prepare: async (_owner, _id, environment) => {
      if (environment.type !== 'none') throw new Error('Test environment is none');
      return environment;
    },
    start: async (_owner, _session, binding) => {
      if (seen.has(binding.turn.id)) return;
      seen.add(binding.turn.id);
      calls.push({ type: 'start', turnId: binding.turn.id, input: binding.input });
      observations.set(binding.turn.id, { turn: { ...binding.turn, status: 'in_progress', started_at: 100 }, requiredActions: [] });
    },
    steer: async (_owner, _session, turnId, input, operationId) => {
      if (seen.has(operationId)) return;
      seen.add(operationId);
      calls.push({ type: 'steer', turnId, input });
    },
    cancel: async (_owner, _session, turnId) => {
      calls.push({ type: 'cancel', turnId });
      const observation = observations.get(turnId)!;
      if (observation) observations.set(turnId, { turn: { ...observation.turn, status: 'cancelled', completed_at: 110 }, requiredActions: [] });
    },
    toolResult: async (_owner, _session, event) => { calls.push({ type: 'tool_result', turnId: event.turn_id, input: event }); },
    observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
    items: async () => [], artifacts: async () => [],
    artifactContent: async () => new ReadableStream({ start(controller) { controller.close(); } }),
  };
  const agents = new AgentService({ store });
  const sessions = new SessionService({ store, agents, execution, streamIntervalMs: 1 });
  const client = (owner: string) => new OpenAI({
    apiKey: 'test', baseURL: 'https://rat.invalid/v1', maxRetries: 0,
    fetch: (input, init) => routeAgentsRequest(new Request(input, init), owner, { agents, sessions }),
  }).beta.agents;
  return { store, agents, sessions, execution, calls, observations, api: client('alice'), other: client('bob') };
}

describe('Agents API session lifecycle through the OpenAI SDK', () => {
  it.each(['asc', 'desc'] as const)('filters and orders root and child artifacts before %s pagination', async order => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Fixture' });
    const root = (await f.api.sessions.turns.list(session.id)).data[0]!;
    const saved = (id: string, created_at: number, environment_id = 'env_selected', turn_id = root.id) => ({
      artifact: { id, created_at, environment_id, turn_id, session_id: session.id, object: 'agent.session.artifact' as const, path: `/workspace/outputs/${id}`, size_bytes: 1 },
      content: { bucket: 'private', key: id, sha256: 'a'.repeat(64) },
    });
    const roots = [saved('artifact_z', 300), saved('artifact_b', 100), saved('artifact_other', 75, 'env_other')];
    const childArtifacts = [saved('artifact_first', 50, 'env_selected', 'child_turn'), saved('artifact_a', 100, 'env_selected', 'child_turn')];
    const original = structuredClone({ roots, childArtifacts });
    f.execution.artifacts = async () => roots;
    f.execution.subagents = async () => [{
      subagent: { id: 'child', object: 'agent.session.subagent', parent_agent_id: session.agent.id, session_id: session.id,
        opened_at: 40, closed_at: 110, status: 'closed', name: null, instructions: null },
      turns: [{ ...root, id: 'child_turn', subagent_id: 'child', status: 'completed', completed_at: 110 }], items: [], artifacts: childArtifacts,
    }];
    await f.api.sessions.artifacts.delete('artifact_z', { session_id: session.id });
    const expected = order === 'asc' ? ['artifact_first', 'artifact_a', 'artifact_b'] : ['artifact_b', 'artifact_a', 'artifact_first'];
    const ids: string[] = [];
    for await (const artifact of f.api.sessions.artifacts.list(session.id, { environment_id: 'env_selected', order, limit: 1 })) ids.push(artifact.id);
    expect(ids).toEqual(expected);
    expect((await f.api.sessions.artifacts.list(session.id, { environment_id: 'env_missing' })).data).toEqual([]);
    expect((await f.api.sessions.artifacts.list(session.id, { environment_id: null })).data).toHaveLength(4);
    await expect(f.other.sessions.artifacts.list(session.id, { environment_id: 'env_selected' })).rejects.toMatchObject({ status: 404 });
    expect({ roots, childArtifacts }).toEqual(original);
  });

  it('replans input when terminal-history materialization wins the Session write', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'First' });
    await f.sessions.dispatch('alice', session.id);
    const first = (await f.api.sessions.turns.list(session.id)).data[0]!;
    f.observations.set(first.id, { turn: { ...first, status: 'completed', completed_at: 110 }, requiredActions: [] });
    const put = f.store.put.bind(f.store);
    let interleave = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection === 'sessions' && interleave) {
        interleave = false;
        await f.sessions.completeTurn('alice', session.id, first.id);
      }
      return put(resource, revision);
    });
    const request = { events: [{ type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Second' }] }] }], 'Idempotency-Key': 'next' };
    await f.api.sessions.events.create(session.id, request);
    await f.api.sessions.events.create(session.id, request);
    await f.sessions.dispatch('alice', session.id);
    const turns = (await f.api.sessions.turns.list(session.id, { order: 'asc' })).data;
    expect(turns).toHaveLength(2);
    expect(turns.find(turn => turn.id === first.id)?.status).toBe('completed');
    expect(f.calls.filter(call => call.type === 'start')).toHaveLength(2);
    const state = (await f.store.get<import('../../src/core/session-ports.js').SessionState>('alice', 'sessions', session.id))!.value;
    expect(state.turns.find(binding => binding.turn.id === first.id)).toMatchObject({ savedItems: [], savedArtifacts: [] });
    expect(state.turns.flatMap(binding => binding.input).filter(message => JSON.stringify(message.content).includes('Second'))).toHaveLength(1);
  });

  it('recognizes a concurrently committed receipt without adding the same input twice', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'First' });
    const request = { events: [{ type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Once' }] }] }], 'Idempotency-Key': 'same' };
    const put = f.store.put.bind(f.store);
    let interleave = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection === 'sessions' && interleave) {
        interleave = false;
        await f.api.sessions.events.create(session.id, request);
      }
      return put(resource, revision);
    });
    await f.api.sessions.events.create(session.id, request);
    expect((await f.api.sessions.items.list(session.id)).data.filter(item => JSON.stringify(item).includes('Once'))).toHaveLength(1);
  });

  it('does not revive a deleted Session while retrying conflicting input', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'First' });
    const put = f.store.put.bind(f.store);
    let interleave = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection === 'sessions' && interleave) { interleave = false; await f.api.sessions.delete(session.id); }
      return put(resource, revision);
    });
    await expect(f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] })).rejects.toMatchObject({ status: 404 });
    expect(await f.store.get('alice', 'sessions', session.id)).toBeUndefined();
  });

  it('does not repeat an ambiguous input write before the caller retries its receipt', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'First' });
    const put = f.store.put.bind(f.store);
    const write = vi.spyOn(f.store, 'put').mockImplementationOnce(async (resource, revision) => {
      await put(resource, revision); throw new Error('Commit acknowledgement lost');
    });
    const request = { events: [{ type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Once' }] }] }], 'Idempotency-Key': 'ambiguous' };
    await expect(f.api.sessions.events.create(session.id, request)).rejects.toMatchObject({ status: 500 });
    expect(write).toHaveBeenCalledTimes(1);
    await f.api.sessions.events.create(session.id, request);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('clears saved MCP tools before preparing credentials when a session overrides tools with null', async () => {
    const f = fixture();
    const preparedHeaders: Record<string, string>[] = [];
    const vaults = new VaultService({ store: f.store, secrets: {
      create: async () => { throw new Error('No vault credentials in this fixture'); },
      read: async () => { throw new Error('No vault credentials in this fixture'); },
      revoke: async () => {},
    } });
    const resolveCredential = vi.spyOn(vaults, 'resolve');
    const tools = new SessionToolService({ store: f.store, vaults, secrets: {
      reference: (_identity, attempt) => `secret-${attempt}`,
      create: async (value) => { preparedHeaders.push(value.headers); },
      revoke: async () => {},
    } });
    f.execution.prepare = async (owner, id, environment, agent, vaults, parameters = []) => {
      await tools.prepare(owner, id, agent, parameters, vaults);
      if (environment.type !== 'none') throw new Error('Test environment is none');
      return environment;
    };
    const saved = await f.api.create({ model: 'test', tools: [{ type: 'mcp', server_label: 'saved',
      transport: { type: 'http', server_url: 'https://saved.example/mcp', headers: { 'X-Workspace': 'saved-context' } },
    }] });
    for (const override of [null, []]) {
      const session = await f.api.sessions.create({ agent_id: saved.id, agent: { tools: override }, environment: { type: 'none' }, input: 'Start' });
      expect(session.agent.tools).toEqual([]);
      expect((await f.store.get('alice', 'session_tools', session.id))?.value).toEqual([]);
    }
    expect(preparedHeaders).toEqual([]);
    expect(resolveCredential).not.toHaveBeenCalled();
    const inherited = await f.api.sessions.create({ agent_id: saved.id, environment: { type: 'none' }, input: 'Start' });
    expect(inherited.agent.tools).toMatchObject([{ type: 'mcp', server_label: 'saved' }]);
    expect(preparedHeaders).toEqual([{ 'X-Workspace': 'saved-context' }]);
    expect(resolveCredential).toHaveBeenCalledExactlyOnceWith('alice', [], 'https://saved.example/mcp', null, true);
    expect(await f.api.retrieve(saved.id)).toEqual(saved);
  });

  it('deletes queued work by closing the harness even when its control channel is unavailable', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    f.execution.observe = async () => { throw new Error('Worker unavailable'); };
    f.execution.cancel = async () => { throw new Error('Turn never reached worker'); };
    const closed: string[] = [];
    f.execution.close = async (_owner, value) => { closed.push(value.id); };
    expect(await f.api.sessions.delete(session.id)).toMatchObject({ deleted: true });
    expect(closed).toEqual([session.id]);
    await expect(f.api.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404 });
  });
  it('records an asynchronous initial-input failure without resubmitting it', async () => {
    const f = fixture();
    let attempts = 0;
    f.execution.start = async () => { attempts++; throw new AgentsApiError(408, 'The environment did not connect.', 'environment_connection_timeout'); };
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await f.sessions.dispatch('alice', session.id);
    expect(await f.api.sessions.retrieve(session.id)).toMatchObject({ status: 'failed', required_actions: [] });
    expect((await f.api.sessions.turns.list(session.id)).data[0]).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
    await f.sessions.dispatch('alice', session.id);
    expect(attempts).toBe(1);
  });

  it('streams typed events through the SDK until the initial root turn completes', async () => {
    const f = fixture();
    const stream = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start', stream: true });
    const types: string[] = [];
    for await (const event of stream) {
      parseAgentsContract('SessionEvent', event);
      types.push(event.type);
      if (event.type === 'agent.session.created') {
        await f.sessions.dispatch('alice', event.session.id);
        const turn = (await f.api.sessions.turns.list(event.session.id)).data[0]!;
        f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 110 }, requiredActions: [] });
      }
    }
    expect(types).toContain('agent.session.turn.created');
    expect(types).toContain('agent.session.turn.completed');
    expect(types.at(-1)).toBe('agent.session.idle');
  });

  it('subscribes before flushing headers, does not replay old items, and cancels a live stream', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Before subscription' });
    const stream = await f.api.sessions.events.stream(session.id);
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'After subscription' }] }] }] });
    const received: string[] = [];
    for await (const event of stream) {
      parseAgentsContract('SessionEvent', event);
      if (event.type === 'agent.session.turn.item.added' && event.item.type === 'message') {
        received.push(...event.item.content.flatMap((part) => part.type === 'input_text' ? [part.text] : []));
        stream.controller.abort();
      }
    }
    expect(received).toEqual(['After subscription']);
  });

  it('snapshots configuration, steers an active turn, and starts a new turn after completion', async () => {
    const f = fixture();
    const agent = await f.api.create({ model: 'test-model', instructions: 'Original instructions' });
    const session = await f.api.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: 'First input' });
    parseAgentsContract('Session', session);
    expect(session.status).toBe('in_progress');
    expect(f.calls).toEqual([]);
    await f.sessions.dispatch('alice', session.id);
    await f.api.update(agent.id, { instructions: 'New instructions' });
    expect((await f.api.sessions.retrieve(session.id)).agent.instructions).toBe('Original instructions');
    const first = (await f.api.sessions.turns.list(session.id)).data[0]!;
    parseAgentsContract('Turn', first);
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'More context' }] }] }], 'Idempotency-Key': 'input-2' });
    await f.sessions.dispatch('alice', session.id);
    expect(f.calls.map((call) => [call.type, call.turnId])).toEqual([['start', first.id], ['steer', first.id]]);
    expect((await f.api.sessions.turns.list(session.id)).data).toHaveLength(1);
    f.observations.set(first.id, { turn: { ...first, status: 'completed', completed_at: 110 }, requiredActions: [] });
    expect((await f.api.sessions.retrieve(session.id)).status).toBe('idle');
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Next task' }] }] }] });
    await f.sessions.dispatch('alice', session.id);
    expect((await f.api.sessions.turns.list(session.id)).data).toHaveLength(2);
    expect(f.calls.at(-1)?.type).toBe('start');
    expect(f.calls.at(-1)?.turnId).not.toBe(first.id);
    const items = await f.api.sessions.items.list(session.id, { order: 'asc' });
    expect(items.data.map((item) => item.turn_id)).toEqual([first.id, first.id, f.calls.at(-1)?.turnId]);
    items.data.forEach((item) => parseAgentsContract('Item', item));
  });

  it('deduplicates accepted events and repairs a failed outbox delivery without changing turn IDs', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    const input = { events: [{ type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Steer' }] }] }], 'Idempotency-Key': 'retryable' };
    await f.api.sessions.events.create(session.id, input);
    await f.api.sessions.events.create(session.id, input);
    const steer = f.execution.steer;
    let fail = true;
    f.execution.steer = async (...args) => { if (fail) { fail = false; throw new Error('Temporary worker connection failure'); } await steer(...args); };
    await expect(f.sessions.dispatch('alice', session.id)).rejects.toThrow('Temporary worker connection failure');
    await f.sessions.dispatch('alice', session.id);
    await f.sessions.dispatch('alice', session.id);
    expect(f.calls.map((call) => call.type)).toEqual(['start', 'steer']);
    expect(JSON.stringify(f.calls[0]?.input)).not.toContain('Steer');
    await expect(f.api.sessions.events.create(session.id, { ...input, events: [{ type: 'agent.session.input.cancel' }] })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps steering after existing output and retains artifact references after the worker expires', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'First' });
    await f.sessions.dispatch('alice', session.id);
    const turn = (await f.api.sessions.turns.list(session.id)).data[0]!;
    const output = { id: 'out_1', type: 'message' as const, role: 'assistant' as const, phase: 'commentary' as const, status: 'completed' as const, turn_id: turn.id, content: [{ type: 'output_text' as const, text: 'Working' }] };
    f.execution.items = async () => [output];
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Adjustment' }] }] }] });
    f.execution.items = async () => [output, { ...output, id: 'out_2', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }];
    const items = (await f.api.sessions.items.list(session.id, { order: 'asc' })).data;
    expect(items.map((item) => item.type === 'message' ? item.content[0]?.type === 'input_text' || item.content[0]?.type === 'output_text' ? item.content[0].text : '' : '')).toEqual(['First', 'Working', 'Adjustment', 'Done']);
    const artifact = { id: 'artifact_1', object: 'agent.session.artifact' as const, session_id: session.id, turn_id: turn.id, environment_id: 'env_1', path: '/workspace/result.bin', size_bytes: 3, created_at: 110 };
    f.execution.artifacts = async () => [{ artifact, content: { bucket: 'private', key: 'immutable-result', sha256: 'a'.repeat(64) } }];
    f.execution.artifactContent = async (_owner, _session, saved) => {
      expect(saved.content.key).toBe('immutable-result');
      return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 255, 128])); controller.close(); } });
    };
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 110 }, requiredActions: [] });
    await f.sessions.completeTurn('alice', session.id, turn.id);
    f.execution.items = async () => { throw new Error('Expired worker'); };
    f.execution.artifacts = async () => { throw new Error('Expired worker'); };
    f.execution.observe = async () => { throw new Error('Expired worker'); };
    expect((await f.api.sessions.items.list(session.id)).data).toHaveLength(4);
    expect((await f.api.sessions.artifacts.list(session.id)).data).toEqual([artifact]);
    const bytes = await f.api.sessions.artifacts.content(artifact.id, { session_id: session.id });
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });

  it('cancels a turn while retaining the session, input history, and ownership boundaries', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await f.sessions.dispatch('alice', session.id);
    const turn = (await f.api.sessions.turns.list(session.id)).data[0]!;
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    await f.sessions.dispatch('alice', session.id);
    expect((await f.api.sessions.turns.retrieve(turn.id, { session_id: session.id })).status).toBe('cancelled');
    expect((await f.api.sessions.retrieve(session.id)).status).toBe('idle');
    expect((await f.api.sessions.items.list(session.id)).data).toHaveLength(1);
    await expect(f.other.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.other.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] })).rejects.toMatchObject({ status: 404 });
    await expect(f.other.sessions.delete(session.id)).rejects.toMatchObject({ status: 404 });
    expect((await f.other.sessions.list()).data).toEqual([]);
    expect(await f.api.sessions.delete(session.id)).toEqual({ id: session.id, object: 'agent.session.deleted', deleted: true });
    await expect(f.api.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404 });
  });

  it('cancels accepted work before an executor connects without starting that turn', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    await f.sessions.dispatch('alice', session.id);
    expect(f.calls.some((call) => call.type === 'start')).toBe(false);
    expect((await f.api.sessions.turns.list(session.id)).data[0]?.status).toBe('cancelled');
    expect((await f.api.sessions.retrieve(session.id)).status).toBe('idle');
  });

  it.each(['completed', 'failed', 'in_progress', 'waiting'] as const)('preserves %s when cancellation races a retry of an unacknowledged start', async (status) => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    // The harness started, but the outbox acknowledgement did not commit.
    vi.spyOn(f.store, 'put').mockRejectedValueOnce(new Error('Acknowledgement unavailable'));
    await expect(f.sessions.dispatch('alice', session.id)).rejects.toThrow('Acknowledgement unavailable');
    const turn = (await f.api.sessions.turns.list(session.id)).data[0]!;
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    const completed_at = status === 'completed' || status === 'failed' ? 110 : null;
    f.observations.set(turn.id, { turn: { ...turn, status, completed_at }, requiredActions: [] });
    // Interruption may lose to completion or still await native acknowledgement.
    f.execution.cancel = async () => {};
    await f.sessions.dispatch('alice', session.id);
    expect(await f.api.sessions.turns.retrieve(turn.id, { session_id: session.id })).toMatchObject({ status, completed_at });
    expect((await f.api.sessions.items.list(session.id)).data).toHaveLength(1);
    expect(f.calls.filter((call) => call.type === 'start')).toHaveLength(1);
  });

  it('accepts results only for pending calls and preserves an explicit empty-string output', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await f.sessions.dispatch('alice', session.id);
    const turn = (await f.api.sessions.turns.list(session.id)).data[0]!;
    const requiredActions: AgentSession['required_actions'] = [{ type: 'function_call', turn_id: turn.id, call_id: 'call_1', name: 'lookup', arguments: { query: 'x' } }];
    f.observations.set(turn.id, { turn: { ...turn, status: 'waiting' }, requiredActions });
    expect((await f.api.sessions.retrieve(session.id)).status).toBe('requires_action');
    const event = { type: 'agent.session.input.tool_result' as const, turn_id: turn.id, call_id: 'call_1', success: true, output: '' };
    await expect(f.api.sessions.events.create(session.id, { events: [{ ...event, call_id: 'other' }] })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.sessions.events.create(session.id, { events: [event, event] })).rejects.toMatchObject({ status: 400 });
    await f.api.sessions.events.create(session.id, { events: [event] });
    await f.sessions.dispatch('alice', session.id);
    expect(f.calls.at(-1)).toEqual({ type: 'tool_result', turnId: turn.id, input: event });
  });

  it('validates immutable configuration and invalid model changes before persistence', async () => {
    const f = fixture();
    await expect(f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' } })).rejects.toMatchObject({ status: 400 });
    expect(f.store.resources.size).toBe(0);
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await expect(f.sessions.update('alice', session.id, { agent: { instructions: 'Other' } })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.sessions.update(session.id, { agent: { model: ' ' } })).rejects.toMatchObject({ status: 400 });
    await f.api.sessions.update(session.id, { metadata: { purpose: 'test' } });
    expect((await f.api.sessions.update(session.id, { metadata: null })).metadata).toEqual({});
  });

  it('applies partial Session model updates to future Turns without changing admitted Turns or the saved Agent', async () => {
    const f = fixture();
    const saved = await f.api.create({ model: 'gpt-5.4', reasoning: { effort: 'high', summary: 'detailed' }, service_tier: 'priority' });
    const session = await f.api.sessions.create({ agent_id: saved.id, environment: { type: 'none' }, input: 'First' });
    const original = { model: 'gpt-5.4', reasoning: { effort: 'high' }, service_tier: 'priority' };
    const update = await f.api.sessions.update(session.id, { agent: { model: 'gpt-6-astra', reasoning: { effort: null }, service_tier: null }, metadata: { updated: 'yes' } });
    expect(update.agent).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'low', summary: 'detailed' }, service_tier: 'auto' });
    expect((await f.api.sessions.update(session.id, { agent: { reasoning: {} } })).agent).toEqual(update.agent);
    expect(await f.api.retrieve(saved.id)).toEqual(saved);
    await expect(f.other.sessions.update(session.id, { agent: { model: 'gpt-5.4' } })).rejects.toMatchObject({ status: 404 });
    const start = vi.spyOn(f.execution, 'start');
    await f.sessions.dispatch('alice', session.id);
    expect(start.mock.calls[0]![2].modelSettings).toEqual(original);
    const first = (await f.api.sessions.turns.list(session.id)).data[0]!;
    f.observations.set(first.id, { turn: { ...first, status: 'completed', completed_at: 110 }, requiredActions: [] });
    await f.api.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Next' }] }] }] });
    // A second edit before outbox dispatch must not rewrite the accepted next Turn.
    await f.api.sessions.update(session.id, { agent: { reasoning: { effort: 'max' } } });
    await f.sessions.dispatch('alice', session.id);
    expect(start.mock.calls[1]![2].modelSettings).toEqual({ model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'auto' });
    expect((await f.api.sessions.retrieve(session.id)).agent.reasoning).toEqual({ effort: 'max', summary: 'detailed' });
    expect((await f.api.sessions.artifacts.list(session.id, { after: null, limit: null })).data).toEqual([]);
  });

  it('preserves acceptance order for tool results and input in the same event batch', async () => {
    const f = fixture();
    const session = await f.api.sessions.create({ agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
    await f.sessions.dispatch('alice', session.id);
    const turn = (await f.api.sessions.turns.list(session.id)).data[0]!;
    f.execution.items = async () => [{ id: 'call_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: {}, turn_id: turn.id, status: 'in_progress' }];
    f.observations.set(turn.id, { turn: { ...turn, status: 'waiting' }, requiredActions: [{ type: 'function_call', turn_id: turn.id, call_id: 'call_1', name: 'lookup', arguments: {} }] });
    await f.api.sessions.events.create(session.id, { events: [
      { type: 'agent.session.input.tool_result', turn_id: turn.id, call_id: 'call_1', success: true, output: '' },
      { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue with this result' }] }] },
    ] });
    const beforeEcho = (await f.api.sessions.items.list(session.id, { order: 'asc' })).data;
    expect(beforeEcho.map(item => item.type)).toEqual(['message', 'function_call', 'function_call_output', 'message']);
    const output = beforeEcho.find(item => item.type === 'function_call_output')!;
    const originalItems = f.execution.items;
    f.execution.items = async (...args) => [...await originalItems(...args), { ...output, id: 'fresult_native_call_1', output: [{ type: 'input_text', text: '' }] }];
    expect((await f.api.sessions.items.list(session.id, { order: 'asc' })).data).toEqual(beforeEcho);
  });
});
