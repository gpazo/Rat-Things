import { describe, expect, it, vi } from 'vitest';
import { requireSessionBackend, selectSessionBackend, sessionPlacementFromEnv, type SessionPlacementPolicy } from '../../src/app/session-placement.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionPreparation } from '../../src/core/session-preparation-planning.js';
import { integrationFixture } from './integration-fixtures.js';

async function fixture() {
  const f = await integrationFixture();
  const policy: SessionPlacementPolicy = { ec2Workloads: [{ owner_id: 'operator', agent_id: f.agent.id }], availableBackends: ['microvm', 'ec2'] };
  f.execution.placement = vi.fn((owner, agentId) => {
    const backend = selectSessionBackend(policy, owner, agentId);
    requireSessionBackend(policy, backend);
    return backend;
  });
  f.execution.initialize = vi.fn(async () => {});
  const input = { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Begin' };
  return { ...f, policy, input };
}

describe('Session workload placement', () => {
  it('defaults to MicroVM even when EC2 is enabled or an old global default requests it', () => {
    const policy = sessionPlacementFromEnv({ EC2_WORKER_ENABLED: 'true', DEFAULT_EXECUTION_BACKEND: 'ec2' });
    expect(selectSessionBackend(policy, 'operator', 'agent')).toBe('microvm');
    expect(policy.availableBackends).toEqual(['microvm', 'ec2']);
  });

  it('requires an exact owner and saved Agent match', () => {
    const policy = sessionPlacementFromEnv({ EC2_WORKER_ENABLED: 'true', EC2_SESSION_WORKLOADS_JSON: JSON.stringify([{ owner_id: 'alice', agent_id: 'agent_long' }]) });
    expect(selectSessionBackend(policy, 'alice', 'agent_long')).toBe('ec2');
    expect(selectSessionBackend(policy, 'bob', 'agent_long')).toBe('microvm');
    expect(selectSessionBackend(policy, 'alice', 'agent_other')).toBe('microvm');
    expect(selectSessionBackend(policy, 'alice')).toBe('microvm');
  });

  it('rejects malformed or unavailable workload configuration', () => {
    expect(() => sessionPlacementFromEnv({ EC2_SESSION_WORKLOADS_JSON: '[{"owner_id":"alice"}]' })).toThrow('owner_id and agent_id');
    expect(() => sessionPlacementFromEnv({ EC2_SESSION_WORKLOADS_JSON: '[{"owner_id":"alice","agent_id":"agent"}]' })).toThrow('not enabled');
    const policy = sessionPlacementFromEnv({ MICROVM_ENABLED: 'false', EC2_WORKER_ENABLED: 'true' });
    expect(selectSessionBackend(policy, 'alice')).toBe('microvm');
    expect(() => requireSessionBackend(policy, 'microvm')).toThrow('not enabled');
  });

  it('keeps placement private and unchanged across policy and metadata edits and later Turns', async () => {
    const f = await fixture();
    const session = await f.sessions.create('operator', f.input);
    expect(session).not.toHaveProperty('placement');
    expect((await f.store.get<SessionState>('operator', 'sessions', session.id))?.value.placement).toBe('ec2');
    f.policy.ec2Workloads = [];
    await f.sessions.update('operator', session.id, { metadata: { backend: 'microvm' } });
    await f.sessions.dispatch('operator', session.id);
    expect(f.execution.initialize).toHaveBeenLastCalledWith('operator', expect.objectContaining({ id: session.id }), 'ec2');
    expect(f.execution.start).toHaveBeenLastCalledWith('operator', expect.anything(), expect.anything(), expect.anything(), 'ec2');
    const first = [...f.observations.values()][0]!;
    f.observations.set(first.turn.id, { ...first, turn: { ...first.turn, status: 'completed', completed_at: 10 } });
    await f.sessions.events('operator', session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }] }] }, 'next');
    await f.sessions.dispatch('operator', session.id);
    expect(f.execution.start).toHaveBeenCalledTimes(2);
    expect(f.execution.start).toHaveBeenLastCalledWith('operator', expect.anything(), expect.anything(), expect.anything(), 'ec2');
    expect(f.execution.placement).toHaveBeenCalledTimes(1);
  });

  it('does not promote inline Agents through metadata or a deployment-wide EC2 default', async () => {
    const f = await fixture();
    const session = await f.sessions.create('operator', { agent: { model: 'test' }, environment: { type: 'none' }, input: 'Begin', metadata: { 'rat_things.execution': 'long_running' } });
    await f.sessions.dispatch('operator', session.id);
    expect(f.execution.start).toHaveBeenLastCalledWith('operator', expect.anything(), expect.anything(), expect.anything(), 'microvm');
  });

  it('reuses the first preparation placement after a failed effect and policy change', async () => {
    const f = await fixture();
    const prepare = vi.fn(f.execution.prepare).mockRejectedValueOnce(new Error('Interrupted'));
    f.execution.prepare = prepare;
    await expect(f.sessions.create('operator', f.input, 'sess_retry')).rejects.toThrow('Interrupted');
    f.policy.ec2Workloads = [];
    const session = await f.sessions.create('operator', f.input, 'sess_retry');
    expect((await f.store.get<SessionPreparation>('operator', 'session_preparations', session.id))?.value.placement).toBe('ec2');
    expect(prepare.mock.calls.map(call => call[7])).toEqual(['ec2', 'ec2']);
    expect(f.execution.placement).toHaveBeenCalledTimes(1);
  });

  it('uses the committed winner when a preparation acknowledgement is lost', async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      await put(resource, revision);
      if (resource.collection === 'session_preparations') throw new Error('Lost acknowledgement');
    });
    const session = await f.sessions.create('operator', f.input);
    expect((await f.store.get<SessionState>('operator', 'sessions', session.id))?.value.placement).toBe('ec2');
  });

  it('adopts a competing preparation placement instead of the local selection', async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection !== 'session_preparations') return put(resource, revision);
      await put({ ...resource, value: { ...(resource.value as SessionPreparation), placement: 'microvm' } }, revision);
      throw new Error('Concurrent winner');
    });
    const prepare = vi.spyOn(f.execution, 'prepare');
    const session = await f.sessions.create('operator', f.input);
    expect((await f.store.get<SessionState>('operator', 'sessions', session.id))?.value.placement).toBe('microvm');
    expect(prepare.mock.calls[0]?.[7]).toBe('microvm');
  });

  it('defaults legacy Sessions without placement to MicroVM', async () => {
    const f = await fixture();
    const session = await f.sessions.create('operator', f.input);
    const saved = (await f.store.get<SessionState>('operator', 'sessions', session.id))!;
    delete saved.value.placement;
    await f.store.put({ ...saved, revision: saved.revision + 1 }, saved.revision);
    await f.sessions.dispatch('operator', session.id);
    expect(f.execution.start).toHaveBeenLastCalledWith('operator', expect.anything(), expect.anything(), expect.anything(), 'microvm');
  });

  it('rejects unavailable placement before preparing or creating a Session', async () => {
    const f = await fixture();
    f.policy.availableBackends = ['microvm'];
    const prepare = vi.spyOn(f.execution, 'prepare');
    await expect(f.sessions.create('operator', f.input)).rejects.toMatchObject({ status: 503 });
    expect(prepare).not.toHaveBeenCalled();
    expect((await f.store.list('operator', 'sessions', {})).data).toEqual([]);
  });
});
