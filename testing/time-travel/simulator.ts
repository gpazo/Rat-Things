import { ExecutionCommandService } from '../../src/core/execution-command-service.js';
import { MemoryAgentsStore } from '../../tests/agents/fixtures.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import type { AgentsStore } from '../../src/core/agents-ports.js';
import { canonical, command, defaultFixture, enabled, hash, resultFor, returned, rootHash, selectChoice, sourceIdentity, target, violations,
  type Actor, type Choice, type Event, type Fixture, type Gate, type Operation, type Outcome, type Provenance, type Trace, type World } from './model.js';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function failure(error: unknown): Outcome {
  if (!(error instanceof Error)) throw new Error('Unsupported non-Error port rejection.');
  return { kind: 'threw', error: { name: error.name, message: error.message, ...(error instanceof AgentsApiError ? { status: error.status, code: error.code, param: error.param } : {}) } };
}
type LiveGate = { gate: Gate; promise: ReturnType<typeof deferred<unknown>>; native?: { value: unknown } | { error: unknown } };
type LiveActor = { actor: Actor; boundary: ReturnType<typeof deferred<void>> };

export class Simulator {
  private readonly store = new MemoryAgentsStore();
  private readonly actors = new Map<string, LiveActor>();
  private readonly gates = new Map<string, LiveGate>();
  private readonly effects: World['effects'] = [];
  private readonly claims: string[] = [];
  private readonly invocations: World['invocations'] = [];
  private observations: unknown[] = [];
  private now = 0;
  private faults = 0;
  private readonly recorded: Event[] = [];
  public get events(): Event[] { return structuredClone(this.recorded); }
  public get fixture(): Fixture { return structuredClone(this.initialFixture); }
  public get provenance(): Provenance { return structuredClone(this.identity); }
  private constructor(private readonly initialFixture: Fixture, private readonly identity: Provenance) {
    for (const id of [...initialFixture.actors, ...Array.from({ length: initialFixture.restarts }, (_, i) => `restart-${i + 1}`)]) {
      this.actors.set(id, { actor: { id, status: 'new', calls: 0 }, boundary: deferred<void>() });
    }
  }
  public static async create(fixture: Fixture, provenance: Provenance) {
    const runner = new Simulator(structuredClone(fixture), structuredClone(provenance));
    await runner.store.put(command(fixture), 0); return runner;
  }
  public snapshot(): World {
    return structuredClone({ now: this.now, faults: this.faults,
      resources: [...this.store.resources.values()].sort((a, b) => a.collection.localeCompare(b.collection)),
      actors: [...this.actors.values()].map((a) => a.actor).sort((a, b) => a.id.localeCompare(b.id)),
      gates: [...this.gates.values()].map((g) => g.gate).sort((a, b) => a.id.localeCompare(b.id)),
      effects: this.effects, claims: this.claims, invocations: this.invocations });
  }
  private invoke<T>(actor: LiveActor, operation: Operation): Promise<T> {
    const id = `${actor.actor.id}:${++actor.actor.calls}`;
    const live: LiveGate = { gate: { id, actor: actor.actor.id, operation: structuredClone(operation), phase: 'invoked' }, promise: deferred<unknown>() };
    this.gates.set(id, live); actor.actor.status = 'waiting';
    this.invocations.push({ actor: actor.actor.id, target: this.consumerTarget(), operation: structuredClone(operation) });
    this.observations.push({ kind: 'invoked', gate: structuredClone(live.gate) });
    actor.boundary.resolve();
    return live.promise.promise as Promise<T>;
  }
  private consumerTarget() { return this.fixture.staleTarget ? { ...target, execution: { ...target.execution, generation: 'stale' } } : target; }
  private start(actor: LiveActor): void {
    const store: AgentsStore = {
      get: (ownerId, collection, id) => this.invoke(actor, { kind: 'get', ownerId, collection, id }),
      list: (ownerId, collection, query) => this.invoke(actor, { kind: 'list', ownerId, collection, query }),
      put: (resource, expectedRevision) => this.invoke(actor, { kind: 'put', resource, expectedRevision }),
      commit: (writes) => this.invoke(actor, { kind: 'commit', writes }),
      delete: (resource, writes = []) => this.invoke(actor, { kind: 'delete', resource, writes }),
    };
    const service = new ExecutionCommandService({ store, now: () => { this.observations.push({ kind: 'clock', actor: actor.actor.id, now: this.now }); return this.now; }, id: () => 'unexpected', pause: async () => { throw new Error('Requester polling is outside this simulator.'); } });
    void service.drain('owner', this.consumerTarget(), (request, deadline) => this.invoke(actor, { kind: 'perform', request, deadline, invokedAt: this.now })).then(
      () => this.complete(actor, returned(undefined)), (error: unknown) => this.complete(actor, failure(error)),
    );
  }
  private complete(actor: LiveActor, outcome: Outcome): void {
    actor.actor.status = 'done'; actor.actor.completion = outcome;
    this.observations.push({ kind: 'completed', actor: actor.actor.id, outcome }); actor.boundary.resolve();
  }
  private async apply(live: LiveGate, failBefore: boolean): Promise<void> {
    const op = live.gate.operation;
    try {
      if (failBefore) throw new Error('Injected fail-before');
      let value: unknown;
      switch (op.kind) {
        case 'get': value = await this.store.get(op.ownerId, op.collection, op.id); break;
        case 'list': value = await this.store.list(op.ownerId, op.collection, op.query); break;
        case 'put': {
          const claimed = (op.resource.value as { status?: string }).status === 'claimed';
          if (this.fixture.faultModel === 'unsafe-claim-cas' && claimed) {
            this.store.resources.set(JSON.stringify([op.resource.ownerId, op.resource.collection, op.resource.id]), structuredClone(op.resource));
          } else await this.store.put(op.resource, op.expectedRevision);
          if (claimed) this.claims.push(live.gate.actor);
          break;
        }
        case 'commit': await this.store.commit(op.writes); break;
        case 'delete': await this.store.delete(op.resource, op.writes); break;
        case 'perform': this.effects.push({ command: 'command', actor: live.gate.actor, invokedAt: op.invokedAt, appliedAt: this.now, deadline: op.deadline }); value = { status: 200, body: { accepted: true } }; break;
      }
      live.native = { value }; live.gate = { ...live.gate, phase: 'applied', outcome: returned(value) };
    } catch (error) { live.native = { error }; live.gate = { ...live.gate, phase: 'applied', outcome: failure(error) }; }
    this.observations.push({ kind: 'applied', gate: structuredClone(live.gate) });
  }
  public async step(choice: Choice): Promise<Event> {
    if (!enabled(this.snapshot(), this.fixture).some((c) => canonical(c) === canonical(choice))) throw new Error(`Illegal choice at event ${this.recorded.length + 1}: ${canonical(choice)}`);
    this.observations = [];
    switch (choice.kind) {
      case 'advance': this.now = choice.to; break;
      case 'start': { const actor = this.actors.get(choice.actor)!; actor.boundary = deferred<void>(); this.start(actor); await actor.boundary.promise; break; }
      case 'crash': {
        this.faults++; this.actors.get(choice.actor)!.actor.status = 'dead';
        for (const [id, gate] of this.gates) if (gate.gate.actor === choice.actor) this.gates.delete(id);
        break;
      }
      case 'apply': if (choice.result === 'fail-before') this.faults++; await this.apply(this.gates.get(choice.op)!, choice.result === 'fail-before'); break;
      case 'ack': {
        const live = this.gates.get(choice.op)!;
        if (live.gate.phase !== 'applied') throw new Error('Expected applied gate.');
        if (choice.delivery !== 'normal') this.faults++;
        if (choice.delivery === 'error') { const error = new Error('Injected lost-result transport error'); live.native = { error }; live.gate = { ...live.gate, phase: 'ready', outcome: failure(error) }; }
        else live.gate = { ...live.gate, phase: choice.delivery === 'lost' ? 'lost' : 'ready' };
        this.observations.push({ kind: 'acknowledged', gate: structuredClone(live.gate) }); break;
      }
      case 'resume': {
        const actor = this.actors.get(choice.actor)!;
        const live = [...this.gates.values()].find((g) => g.gate.actor === choice.actor && g.gate.phase === 'ready')!;
        actor.boundary = deferred<void>(); this.gates.delete(live.gate.id);
        if ('error' in live.native!) live.promise.reject(live.native.error); else live.promise.resolve(live.native!.value);
        await actor.boundary.promise; break;
      }
    }
    const world = this.snapshot();
    const body = { index: this.recorded.length + 1, choice: structuredClone(choice), observations: structuredClone(this.observations), world, worldHash: hash(world), previousHash: this.recorded.at(-1)?.hash ?? rootHash(this.fixture, this.provenance) };
    const event = { ...body, hash: hash(body) }; this.recorded.push(event); return structuredClone(event);
  }
  public trace(seed: number, limit: number): Trace { return { format: 1, fixture: structuredClone(this.fixture), provenance: structuredClone(this.provenance), seed, stepLimit: limit, events: structuredClone(this.recorded), result: resultFor(this.snapshot(), this.fixture, this.recorded.length, limit) }; }
  public async run(seed: number, limit: number, safe = false): Promise<Trace> {
    let state = seed;
    while (this.recorded.length < limit && !violations(this.snapshot(), this.fixture).length) {
      const next = selectChoice(this.snapshot(), this.fixture, state, safe); state = next.state;
      if (!next.choice) break; await this.step(next.choice);
    }
    return this.trace(seed, limit);
  }
}

export async function runChoices(fixture: Fixture, provenance: Provenance, choices: Choice[], limit = choices.length): Promise<Trace> {
  const runner = await Simulator.create(fixture, provenance);
  for (const choice of choices) await runner.step(choice);
  return runner.trace(1, limit);
}
export async function explore(options: { provenance: Provenance; fixture?: Fixture; seed: number; runs: number; steps: number; prefix?: Choice[]; safe?: boolean }) {
  const counts = { violation: 0, completed: 0, parked: 0, 'budget-exhausted': 0 };
  let failureTrace: Trace | undefined; let last: Trace | undefined;
  for (let index = 0; index < options.runs; index++) {
    const runner = await Simulator.create(options.fixture ?? defaultFixture(), options.provenance);
    for (const choice of options.prefix ?? []) await runner.step(choice);
    last = await runner.run(options.seed + index, options.steps, options.safe); counts[last.result.status]++;
    if (last.result.status === 'violation') { failureTrace = last; break; }
  }
  return { counts, runs: Object.values(counts).reduce((a, b) => a + b, 0), bounds: { requestedRuns: options.runs, steps: options.steps }, ...(failureTrace ? { failure: failureTrace } : {}), last: last! };
}
export function validateChain(trace: Trace): void {
  let previous = rootHash(trace.fixture, trace.provenance);
  for (const [index, event] of trace.events.entries()) {
    const { hash: recorded, ...body } = event;
    if (event.index !== index + 1 || event.previousHash !== previous || event.worldHash !== hash(event.world) || recorded !== hash(body)) throw new Error(`Trace integrity failure at event ${index + 1}.`);
    previous = recorded;
  }
}
export async function reconstruct(trace: Trace, provenance: Provenance, through = trace.events.length, parent?: Trace): Promise<Simulator> {
  if (!Number.isInteger(through) || through < 0 || through > trace.events.length) throw new Error('Event point is out of range.');
  if (parent?.parent) throw new Error('Only one branch generation is supported; parent must be a root trace.');
  if (canonical(sourceIdentity(trace.provenance)) !== canonical(sourceIdentity(provenance))) throw new Error('Source/runtime provenance mismatch; verified replay refused.');
  validateChain(trace);
  if (trace.parent) {
    if (!parent) throw new Error('Branched trace requires its parent for verified replay.');
    verifyParent(trace, parent);
    await reconstruct(parent, provenance);
  }
  const runner = await Simulator.create(trace.fixture, trace.provenance);
  for (const expected of trace.events.slice(0, through)) {
    const actual = await runner.step(expected.choice);
    if (canonical(actual) !== canonical(expected)) throw new Error(`Replay divergence at event ${expected.index}.`);
  }
  if (through === trace.events.length && canonical(runner.trace(trace.seed, trace.stepLimit).result) !== canonical(trace.result)) throw new Error('Replay result divergence.');
  return runner;
}
export async function replay(trace: Trace, provenance: Provenance, through = trace.events.length, parent?: Trace) {
  const runner = await reconstruct(trace, provenance, through, parent);
  return { verified: true, at: through, world: runner.snapshot(), worldHash: hash(runner.snapshot()), enabled: enabled(runner.snapshot(), trace.fixture), result: runner.trace(trace.seed, trace.stepLimit).result };
}
export async function branch(trace: Trace, provenance: Provenance, options: { at: number; seed: number; steps: number; first?: Choice; parent?: Trace }): Promise<Trace> {
  if (trace.parent) throw new Error('Further branching is unsupported; branch from a root trace.');
  if (!Number.isInteger(options.steps) || options.steps < 1 || options.at + options.steps > 2000) throw new Error('Branch total step limit must be between 1 and 2000.');
  const runner = await reconstruct(trace, provenance, options.at, options.parent);
  if (options.first) await runner.step(options.first);
  const child = await runner.run(options.seed, options.at + options.steps);
  child.parent = { digest: hash(trace), at: options.at, prefixHash: trace.events[options.at - 1]?.hash ?? rootHash(trace.fixture, trace.provenance) };
  verifyParent(child, trace); return child;
}
export function verifyParent(child: Trace, parent: Trace): void {
  const proof = child.parent;
  if (!proof || !Number.isInteger(proof.at) || proof.at < 0 || proof.digest !== hash(parent) || canonical(sourceIdentity(child.provenance)) !== canonical(sourceIdentity(parent.provenance)) || proof.at > parent.events.length || proof.prefixHash !== (parent.events[proof.at - 1]?.hash ?? rootHash(parent.fixture, parent.provenance)) || canonical(child.events.slice(0, proof.at)) !== canonical(parent.events.slice(0, proof.at)) || canonical(child.fixture) !== canonical(parent.fixture)) throw new Error('Parent prefix proof mismatch.');
}
export async function minimize(trace: Trace, provenance: Provenance, attempts: number, parent?: Trace) {
  await replay(trace, provenance, trace.events.length, parent);
  if (!trace.result.violations.length) throw new Error('Minimization requires a failing trace.');
  const signature = canonical(trace.result.violations); let best = trace; let tested = 0; let accepted = 0;
  const transformations: string[] = [];
  async function tryCandidate(fixture: Fixture, choices: Choice[], label: string) {
    if (tested >= attempts) return false; tested++;
    try {
      const candidate = await runChoices(fixture, provenance, choices);
      if (canonical(candidate.result.violations) !== signature) return false;
      best = candidate; accepted++; transformations.push(label); return true;
    } catch (error) { if (error instanceof Error && error.message.startsWith('Illegal choice')) return false; throw error; }
  }
  const firstViolation = best.events.findIndex((e) => violations(e.world, best.fixture).length);
  if (firstViolation + 1 < best.events.length) await tryCandidate(best.fixture, best.events.slice(0, firstViolation + 1).map((e) => e.choice), 'truncate after first violation');
  for (const actor of [...best.fixture.actors]) {
    if (best.fixture.actors.length <= 1) break;
    await tryCandidate({ ...best.fixture, actors: best.fixture.actors.filter((id) => id !== actor) }, best.events.map((e) => e.choice).filter((c) => !('actor' in c && c.actor === actor) && !('op' in c && c.op.startsWith(`${actor}:`))), `remove actor ${actor}`);
  }
  if (best.fixture.restarts) await tryCandidate({ ...best.fixture, restarts: 0 }, best.events.map((e) => e.choice).filter((c) => !('actor' in c && c.actor.startsWith('restart-')) && !('op' in c && c.op.startsWith('restart-'))), 'remove restart workload');
  let changed = true;
  while (changed && tested < attempts) {
    changed = false;
    for (let size = Math.max(1, Math.floor(best.events.length / 2)); size >= 1 && tested < attempts; size = Math.floor(size / 2)) {
      for (let start = 0; start + size <= best.events.length && tested < attempts; start++) {
        if (await tryCandidate(best.fixture, best.events.filter((_, i) => i < start || i >= start + size).map((e) => e.choice), `remove ${size} choices at ${start + 1}`)) { changed = true; break; }
      }
      if (changed) break;
    }
  }
  return { trace: best, tested, accepted, transformations, originalSteps: trace.events.length, minimizedSteps: best.events.length, stopped: tested >= attempts ? 'attempt-budget' : 'choice-deletion-fixed-point', scope: 'one pass of actor and restart removal, then contiguous choice deletion to a fixed point or attempt bound' };
}
