import { describe, expect, it, vi } from 'vitest';
import { classifyEvent, parseEventFilterDecision } from '../../src/core/event-filter-planning.js';
import { EventCandidateService } from '../../src/core/event-candidate-service.js';
import { validateSourceEventPolicy, type SourceEventPolicy } from '../../src/domain/event-policy.js';
import type { EventCandidate } from '../../src/domain/event-candidates.js';
import type { SessionIntegrationInput } from '../../src/domain/session-integrations.js';
import { MemoryAgentsStore } from './fixtures.js';
import { integrationFixture } from './integration-fixtures.js';

const policy: SourceEventPolicy = { mode: 'candidate', semantic: { policies: ['Act on unresolved release failures.'], maxCandidatesPerHour: 2 } };
const facts = { actorId: 'slack:T1:U1', channelId: 'C1', mentioned: false };
const input: SessionIntegrationInput = { id: 'event-1', text: 'Release failed', source: { kind: 'slack', teamId: 'T1', channelId: 'C1', userId: 'U1', eventId: 'event-1' }, actor: { kind: 'human', provider: 'slack', id: facts.actorId }, credentialSubject: { kind: 'runtime', id: 'runtime:slack' } };
const target = { agentId: 'agent_one', environment: { type: 'none' as const } };

function fixture() {
  const store = new MemoryAgentsStore();
  const model = { id: 'model-one', decide: vi.fn(async (_input: { policies: string[]; eventText: string; threadText: string }) => ({ act: true, reason: 'A policy applies.' })) };
  const integrations = { accept: vi.fn(async (_owner: string, _binding: string, _thread: string, _target: unknown, _input: unknown, writes?: Parameters<MemoryAgentsStore['commit']>[0]) => {
    await store.commit(writes ?? []);
    return { sessionId: 'sess_one' };
  }) };
  const count = vi.fn();
  const service = new EventCandidateService({ store, integrations, model, count, clock: { now: () => 10_000 } });
  const enqueue = (event = input, selected = policy) => service.enqueue('owner', 'binding', 'thread', target, event, selected);
  const state = async (id: string) => (await store.get<EventCandidate>('owner', 'event_candidates', id))!.value;
  return { store, model, integrations, service, count, enqueue, state };
}

describe('event classification', () => {
  it.each([
    ['bot', { ...facts, bot: true, mentioned: true }, policy, true, 'drop'],
    ['self loop', { ...facts, selfLoop: true }, policy, true, 'drop'],
    ['ignore', { ...facts, mentioned: true }, { mode: 'ignore' }, true, 'drop'],
    ['actor deny wins', facts, { ...policy, actors: { allow: [facts.actorId], deny: [facts.actorId] } }, true, 'drop'],
    ['actor allow', facts, { ...policy, actors: { allow: ['someone-else'] } }, true, 'drop'],
    ['channel allow', facts, { ...policy, channels: ['C2'] }, true, 'drop'],
    ['subscription', facts, undefined, true, 'accept'],
    ['mention', { ...facts, mentioned: true }, undefined, false, 'accept'],
    ['candidate', facts, policy, false, 'candidate'],
    ['default explicit', facts, undefined, false, 'drop'],
  ] as const)('%s', (_label, event, selected, subscribed, expected) => {
    expect(classifyEvent(event, selected as SourceEventPolicy | undefined, subscribed)).toBe(expected);
  });
  it('validates policy caps and strict model output at boundaries', () => {
    expect(() => validateSourceEventPolicy({ mode: 'candidate' })).toThrow('requires semantic');
    expect(() => validateSourceEventPolicy({ ...policy, semantic: { policies: ['x'], maxCandidatesPerHour: 0 } })).toThrow('between');
    expect(() => validateSourceEventPolicy({ mode: 'explicit', actors: null } as unknown as SourceEventPolicy)).toThrow('actors');
    expect(() => validateSourceEventPolicy({ mode: 'explicit', actors: { allowed: ['typo'] } } as unknown as SourceEventPolicy)).toThrow('actors');
    expect(() => parseEventFilterDecision({ act: 'yes', reason: 'x' })).toThrow();
    expect(() => parseEventFilterDecision({ act: true, reason: 'x', agent: 'admin' })).toThrow();
    expect(parseEventFilterDecision({ act: false, reason: '' })).toEqual({ act: false, reason: '' });
  });
});

describe('durable candidate filtering', () => {
  it('commits candidate admission and the real integration receipt together', async () => {
    const f = await integrationFixture();
    const service = new EventCandidateService({ store: f.store, integrations: f.integrations, model: { id: 'test', decide: async () => ({ act: true, reason: 'Relevant' }) } });
    const { candidateId } = await service.enqueue('operator', 'binding', 'thread', f.target, f.input, policy);
    await service.process('operator', candidateId);
    const integration = (await f.store.list<{ inputs: SessionIntegrationInput[] }>('operator', 'session_integrations', {})).data[0]!;
    expect(integration.value.inputs[0]?.admission).toBe('candidate');
    expect((await f.store.get<EventCandidate>('operator', 'event_candidates', candidateId))?.value.state.status).toBe('admitted');
    expect(await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input)).toEqual({ sessionId: integration.id });
    expect((await f.store.list<{ inputs: SessionIntegrationInput[] }>('operator', 'session_integrations', {})).data[0]?.value.inputs).toHaveLength(1);
    await f.integrations.submitPending('operator', integration.id);
    expect((await f.sessions.list('operator')).data).toHaveLength(1);
  });
  it('persists before acknowledgement without calling a model and deduplicates delivery', async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.enqueue(), f.enqueue()]);
    expect(two).toEqual(one);
    expect(f.model.decide).not.toHaveBeenCalled();
    await f.service.process('owner', one.candidateId);
    await f.service.process('owner', one.candidateId);
    expect(f.model.decide).toHaveBeenCalledTimes(1);
    expect(f.integrations.accept).toHaveBeenCalledTimes(1);
    expect(f.integrations.accept.mock.calls[0]?.[4]).toMatchObject({ admission: 'candidate' });
    expect((await f.state(one.candidateId)).state.status).toBe('admitted');
    await expect(f.enqueue({ ...input, text: 'changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it.each(['ignore', 'error', 'invalid'] as const)('fails closed on %s', async kind => {
    const f = fixture();
    if (kind === 'ignore') f.model.decide.mockResolvedValue({ act: false, reason: 'Noise.' });
    else if (kind === 'error') f.model.decide.mockRejectedValue(new Error('model unavailable'));
    else f.model.decide.mockResolvedValue({ act: 'yes', reason: 'Invalid' } as never);
    const receipt = await f.enqueue();
    await f.service.process('owner', receipt.candidateId);
    expect(f.integrations.accept).not.toHaveBeenCalled();
    expect((await f.state(receipt.candidateId)).state.status).toBe('discarded');
    if (kind !== 'ignore') expect(f.count).toHaveBeenCalledWith('EventFilterError');
  });
  it('atomically caps burst candidates and preserves policy snapshots', async () => {
    const f = fixture();
    const receipts = await Promise.all(Array.from({ length: 4 }, (_, n) => f.enqueue({ ...input, id: `e${n}` })));
    const states = await Promise.all(receipts.map(r => f.state(r.candidateId)));
    expect(states.filter(s => s.state.status === 'pending')).toHaveLength(2);
    expect(states.filter(s => s.state.status === 'discarded')).toHaveLength(2);
    await f.enqueue({ ...input, id: 'e0' }, { ...policy, semantic: { policies: ['changed'], maxCandidatesPerHour: 100 } });
    expect((await f.state(receipts[0]!.candidateId)).policies).toEqual(policy.semantic!.policies);
  });
  it('lets an explicit mention win while the model is running', async () => {
    const f = fixture();
    f.model.decide.mockImplementation(async () => {
      await f.service.recordExplicit('owner', 'binding', 'thread', 'mention');
      return { act: true, reason: 'Act' };
    });
    const receipt = await f.enqueue();
    await f.service.process('owner', receipt.candidateId);
    expect(f.integrations.accept).not.toHaveBeenCalled();
    expect((await f.state(receipt.candidateId)).state).toMatchObject({ status: 'discarded', decision: { act: false, reason: 'explicit_request_won' } });
  });
  it('fences an explicit mention arriving during final admission', async () => {
    const f = fixture();
    const admit = f.integrations.accept.getMockImplementation()!;
    f.integrations.accept.mockImplementationOnce(async (...args) => {
      await f.service.recordExplicit('owner', 'binding', 'thread', 'mention');
      return admit(...args);
    });
    const receipt = await f.enqueue();
    await f.service.process('owner', receipt.candidateId);
    expect((await f.state(receipt.candidateId)).state.status).toBe('discarded');
    expect(f.model.decide).toHaveBeenCalledTimes(1);
  });
  it('bounds model context and isolates owners', async () => {
    const f = fixture();
    const receipt = await f.enqueue({ ...input, text: 'x'.repeat(20_000) });
    await f.service.process('another-owner', receipt.candidateId);
    expect(f.model.decide).not.toHaveBeenCalled();
    await f.service.process('owner', receipt.candidateId);
    expect(f.model.decide.mock.calls[0]?.[0]).toMatchObject({ eventText: 'x'.repeat(8_000) });
  });
});
