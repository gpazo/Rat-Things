import { describe, expect, it } from 'vitest';
import { canonical, defaultFixture, hash, returned, type Provenance } from '../../testing/time-travel/model.js';
import { Simulator, replay, explore, branch, verifyParent, minimize } from '../../testing/time-travel/simulator.js';
const provenance: Provenance = { sources: {}, runtime: { node: 'test', tsx: 'test', platform: 'test', arch: 'test' }, git: 'test' };
async function port(runner: Simulator, actor: string, ordinal: number) {
  await runner.step({ kind: 'apply', op: `${actor}:${ordinal}`, result: 'normal' });
  await runner.step({ kind: 'ack', op: `${actor}:${ordinal}`, delivery: 'normal' });
  await runner.step({ kind: 'resume', actor });
}
describe('controlled real command continuations', () => {
  it('finds the injected stale-claim race and preserves the real CAS fence', async () => {
    for (const faultModel of ['unsafe-claim-cas', 'correct'] as const) {
      const runner = await Simulator.create(defaultFixture({ actors: ['a', 'b'], restarts: 0, faultModel }), provenance);
      await runner.step({ kind: 'start', actor: 'a' }); await runner.step({ kind: 'start', actor: 'b' });
      await port(runner, 'a', 1); await port(runner, 'b', 1);
      await port(runner, 'a', 2); await port(runner, 'b', 2);
      await port(runner, 'a', 3);
      if (faultModel === 'unsafe-claim-cas') await port(runner, 'b', 3);
      const trace = runner.trace(1, 100);
      expect(trace.result.effects).toBe(faultModel === 'correct' ? 1 : 2);
      expect(trace.result.violations.map((v) => v.property)).toEqual(faultModel === 'correct' ? [] : ['at-most-once']);
      expect((await replay(trace, provenance)).world).toEqual(runner.snapshot());
      if (faultModel === 'correct') expect(runner.snapshot().actors.find((a) => a.id === 'b')?.status).toBe('done');
    }
  });
});

async function oneActor(overrides: Parameters<typeof defaultFixture>[0] = {}) {
  const runner = await Simulator.create(defaultFixture({ actors: ['a'], restarts: 0, ...overrides }), provenance);
  await runner.step({ kind: 'start', actor: 'a' }); return runner;
}

describe('fault boundaries and state ownership', () => {
  it('keeps a committed claim after a lost acknowledgement and abandons the dead continuation', async () => {
    const runner = await oneActor({ restarts: 1 }); await port(runner, 'a', 1);
    await runner.step({ kind: 'apply', op: 'a:2', result: 'normal' });
    await runner.step({ kind: 'ack', op: 'a:2', delivery: 'lost' });
    expect(runner.snapshot().gates[0]?.phase).toBe('lost');
    await expect(runner.step({ kind: 'resume', actor: 'a' })).rejects.toThrow('Illegal choice');
    await runner.step({ kind: 'crash', actor: 'a' });
    const trace = await runner.run(91, 80, true);
    expect(trace.result.effects).toBe(0);
    expect(trace.events.at(-1)?.world.resources[0]?.value).toMatchObject({ status: 'claimed' });
    expect(runner.snapshot().actors.find((a) => a.id === 'a')).toMatchObject({ status: 'dead', calls: 2 });
    expect(runner.snapshot().actors.find((a) => a.id === 'restart-1')).toMatchObject({ status: 'done', calls: 1 });
  });
  it('distinguishes a failed effect acknowledgement from a crash and retains the actual effect', async () => {
    const runner = await oneActor(); await port(runner, 'a', 1); await port(runner, 'a', 2);
    await runner.step({ kind: 'apply', op: 'a:3', result: 'normal' });
    await runner.step({ kind: 'ack', op: 'a:3', delivery: 'error' });
    await runner.step({ kind: 'resume', actor: 'a' }); await port(runner, 'a', 4);
    expect(runner.snapshot().effects).toHaveLength(1);
    expect(runner.snapshot().resources).toHaveLength(1);
    expect(runner.snapshot().resources[0]).toMatchObject({ collection: 'execution_responses_run', value: { status: 'failed' } });
    expect(runner.trace(1, 100).result.status).toBe('completed');
  });
  it('does not apply a fail-before operation or revive an unapplied operation after a crash', async () => {
    const runner = await oneActor(); await port(runner, 'a', 1);
    await runner.step({ kind: 'apply', op: 'a:2', result: 'fail-before' });
    expect(runner.snapshot().resources[0]?.value).toMatchObject({ status: 'queued' });
    await runner.step({ kind: 'ack', op: 'a:2', delivery: 'normal' }); await runner.step({ kind: 'resume', actor: 'a' });
    expect(runner.snapshot().actors[0]).toMatchObject({ status: 'done', completion: { kind: 'threw', error: { message: 'Injected fail-before' } } });
    const dead = await oneActor(); await dead.step({ kind: 'crash', actor: 'a' });
    await expect(dead.step({ kind: 'apply', op: 'a:1', result: 'normal' })).rejects.toThrow('Illegal choice');
  });
  it('checks deadline at invocation while allowing an already invoked operation to apply later', async () => {
    const expired = await oneActor(); await port(expired, 'a', 1);
    await expired.step({ kind: 'apply', op: 'a:2', result: 'normal' }); await expired.step({ kind: 'advance', to: 20 });
    await expired.step({ kind: 'ack', op: 'a:2', delivery: 'normal' }); await expired.step({ kind: 'resume', actor: 'a' });
    const rejected = await expired.run(3, 80, true);
    expect(rejected.result.effects).toBe(0); expect(rejected.events.at(-1)?.world.resources[0]?.value).toMatchObject({ status: 'failed' });
    const slow = await oneActor(); await port(slow, 'a', 1); await port(slow, 'a', 2);
    await slow.step({ kind: 'advance', to: 21 }); await port(slow, 'a', 3); await port(slow, 'a', 4);
    expect(slow.snapshot().effects[0]).toMatchObject({ invokedAt: 0, appliedAt: 21 });
    expect(slow.trace(1, 100).result.violations).toEqual([]);
  });
  it('rejects stale targets before effect invocation', async () => {
    const runner = await oneActor({ staleTarget: true }); const trace = await runner.run(6, 80, true);
    expect(trace.result.effects).toBe(0);
    expect(runner.snapshot().resources[0]?.value).toMatchObject({ status: 'failed', message: 'Execution identity changed.' });
  });
  it('returns owned snapshots and gives terminal completion precedence over the step budget', async () => {
    const runner = await oneActor({ restarts: 1 }); const exported = runner.events; exported[0]!.world.now = 99;
    const fixture = runner.fixture; fixture.deadline = 1;
    const identity = runner.provenance; identity.git = 'mutated';
    expect(runner.events[0]!.world.now).toBe(0); expect(runner.fixture.deadline).toBe(20); expect(runner.provenance.git).toBe('test');
    const event = await runner.step({ kind: 'apply', op: 'a:1', result: 'normal' }); event.world.resources.length = 0;
    expect(runner.events.at(-1)?.world.resources).toHaveLength(1);
    await runner.step({ kind: 'ack', op: 'a:1', delivery: 'normal' }); await runner.step({ kind: 'resume', actor: 'a' });
    await port(runner, 'a', 2); await port(runner, 'a', 3); await port(runner, 'a', 4);
    expect(runner.trace(1, runner.events.length).result.status).toBe('completed');
  });
  it('classifies a lost acknowledgement with no enabled choices as parked at the exact step limit', async () => {
    const runner = await oneActor({ maxFaults: 1, maxTime: 20 });
    await runner.step({ kind: 'apply', op: 'a:1', result: 'normal' });
    await runner.step({ kind: 'ack', op: 'a:1', delivery: 'lost' });
    await runner.step({ kind: 'advance', to: 20 });
    expect(runner.events).toHaveLength(4);
    expect(runner.trace(1, 4).result.status).toBe('parked');
    expect(runner.trace(1, 5).result.status).toBe('parked');
  });
});

describe('verified time travel', () => {
  it('distinguishes undefined outcomes from JSON null', () => { expect(canonical(returned(undefined))).not.toBe(canonical(returned(null))); });
  it('repeats seeded exploration and rejects forged outcomes even after rehashing', async () => {
    const options = { provenance, fixture: defaultFixture({ faultModel: 'unsafe-claim-cas', maxFaults: 0, restarts: 0 }), seed: 17, runs: 20, steps: 80, safe: true };
    const first = await explore(options); const second = await explore(options);
    expect(first).toEqual(second); expect(first.failure?.result.violations).toContainEqual({ property: 'at-most-once', command: 'command' });
    const trace = first.failure!;
    const tampered = structuredClone(trace); tampered.events[0]!.observations = [];
    for (let index = 0; index < tampered.events.length; index++) {
      const event = tampered.events[index]!; if (index) event.previousHash = tampered.events[index - 1]!.hash;
      const { hash: _hash, ...body } = event; event.hash = hash(body);
    }
    await expect(replay(tampered, provenance)).rejects.toThrow('Replay divergence at event 1');
    await expect(replay(trace, { ...provenance, sources: { changed: 'different bytes' } })).rejects.toThrow('provenance mismatch');
    expect((await replay(trace, { ...provenance, git: 'different commit, same bytes' })).verified).toBe(true);
    await expect(replay(trace, provenance, -1)).rejects.toThrow('out of range');
    const unchanged = canonical(trace);
    const child = await branch(trace, provenance, { at: 1, seed: 91, steps: 80 });
    expect(child.events[0]).toEqual(trace.events[0]); expect(canonical(trace)).toBe(unchanged);
    expect(() => verifyParent(child, trace)).not.toThrow();
    await expect(replay(child, provenance)).rejects.toThrow('requires its parent');
    expect((await replay(child, provenance, child.events.length, trace)).verified).toBe(true);
    await expect(branch(child, provenance, { at: 1, seed: 91, steps: 80, parent: trace })).rejects.toThrow('Further branching is unsupported');
    const nestedParent = structuredClone(child); nestedParent.parent!.digest = '0'.repeat(64);
    const nestedChild = structuredClone(child); nestedChild.parent!.digest = hash(nestedParent);
    expect(() => verifyParent(nestedChild, nestedParent)).not.toThrow();
    await expect(replay(nestedChild, provenance, nestedChild.events.length, nestedParent)).rejects.toThrow('parent must be a root trace');
    const forged = structuredClone(child); forged.parent!.digest = '0'.repeat(64);
    expect(() => verifyParent(forged, trace)).toThrow('Parent prefix');
    const zero = await branch(trace, provenance, { at: 0, seed: 91, steps: 80 }); zero.provenance.runtime.node = 'changed';
    expect(() => verifyParent(zero, trace)).toThrow('Parent prefix');
    const reduced = await minimize(trace, provenance, 150);
    expect(reduced.trace.result.violations).toEqual(trace.result.violations); expect(reduced.tested).toBeGreaterThan(0);
    expect(reduced.minimizedSteps).toBeLessThanOrEqual(reduced.originalSteps);
  });
  it('preserves atomic response deletion and creation, including a rejected duplicate response transaction', async () => {
    const runner = await Simulator.create(defaultFixture({ actors: ['a', 'b'], restarts: 0, faultModel: 'unsafe-claim-cas' }), provenance);
    for (const actor of ['a', 'b']) await runner.step({ kind: 'start', actor });
    for (const ordinal of [1, 2, 3]) for (const actor of ['a', 'b']) await port(runner, actor, ordinal);
    await port(runner, 'a', 4); const before = runner.snapshot().resources;
    await runner.step({ kind: 'apply', op: 'b:4', result: 'normal' });
    expect(runner.snapshot().resources).toEqual(before);
    expect(runner.snapshot().gates.find((g) => g.id === 'b:4')).toMatchObject({ outcome: { kind: 'threw', error: { name: 'AgentsApiError', status: 409 } } });
    expect(before).toHaveLength(1); expect(before[0]?.collection).toBe('execution_responses_run');
    for (const event of runner.events) expect(event.world.resources.filter((r) => r.collection === 'execution_responses_run').length + event.world.resources.filter((r) => r.collection === 'execution_commands_run').length).toBe(1);
  });
});
