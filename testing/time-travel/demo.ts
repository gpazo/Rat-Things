import { canonical, defaultFixture, type Choice, type Provenance } from './model.js';
import { branch, explore, minimize, replay, Simulator } from './simulator.js';

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function settlePort(runner: Simulator, actor: string, ordinal: number) {
  await runner.step({ kind: 'apply', op: `${actor}:${ordinal}`, result: 'normal' });
  await runner.step({ kind: 'ack', op: `${actor}:${ordinal}`, delivery: 'normal' });
  await runner.step({ kind: 'resume', actor });
}

async function finishNormally(runner: Simulator, seed = 2) {
  return runner.run(seed, 150, true);
}

export async function demo(identity: Provenance) {
  const fixture = defaultFixture({ faultModel: 'unsafe-claim-cas', restarts: 0 });
  const prefix: Choice[] = [
    { kind: 'start', actor: 'c' },
    { kind: 'apply', op: 'c:1', result: 'normal' },
    { kind: 'ack', op: 'c:1', delivery: 'normal' },
    { kind: 'resume', actor: 'c' },
    { kind: 'crash', actor: 'c' },
  ];
  const campaign = await explore({
    provenance: identity,
    fixture,
    seed: 17,
    runs: 100,
    steps: 80,
    prefix,
    safe: true,
  });
  const original = campaign.failure;
  requireCondition(
    original !== undefined && original.result.violations.some((v) => v.property === 'at-most-once'),
    'Demo search did not find the injected duplicate-effect witness.',
  );
  const verified = await replay(original, identity);
  requireCondition(verified.world.effects.length === 2, 'Witness replay failed.');
  const firstPerform = original.events.findIndex((event) =>
    event.observations.some(
      (observation) =>
        record(observation) &&
        observation.kind === 'invoked' &&
        record(observation.gate) &&
        record(observation.gate.operation) &&
        observation.gate.operation.kind === 'perform',
    ),
  );
  const at = firstPerform + 1;
  requireCondition(at > 0, 'No branch boundary found.');
  const selected = await replay(original, identity, at);
  const victim = selected.world.gates.find((gate) => gate.operation.kind === 'perform')!.actor;
  const alternative = await branch(original, identity, {
    at,
    seed: 91,
    steps: 80,
    first: { kind: 'crash', actor: victim },
  });
  requireCondition(
    alternative.result.effects === 1 &&
      alternative.result.violations.length === 0 &&
      canonical(alternative.events.slice(0, at)) === canonical(original.events.slice(0, at)),
    'Branch did not preserve the prefix and prevent the second effect.',
  );
  await replay(alternative, identity, alternative.events.length, original);
  const reduced = await minimize(original, identity, 300);
  requireCondition(
    reduced.trace.fixture.actors.length < original.fixture.actors.length &&
      reduced.trace.events.length < original.events.length &&
      reduced.trace.result.violations.some((v) => v.property === 'at-most-once'),
    'Minimization did not remove irrelevant actor workload.',
  );
  const correctRunner = await Simulator.create({ ...fixture, faultModel: 'correct' }, identity);
  let skipped = 0;
  for (const event of original.events) {
    try {
      await correctRunner.step(event.choice);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Illegal choice')) {
        skipped++;
      } else {
        throw error;
      }
    }
  }
  const correct = await finishNormally(correctRunner);
  requireCondition(
    correct.result.effects === 1 && correct.result.violations.length === 0,
    'Correct fence rerun failed.',
  );
  const fresh = await explore({
    provenance: identity,
    fixture: defaultFixture(),
    seed: 901,
    runs: 100,
    steps: 100,
  });
  requireCondition(!fresh.failure, 'Correct-store bounded exploration found a violation.');
  const lostRunner = await Simulator.create(defaultFixture({ actors: ['a', 'b'], restarts: 1 }), identity);
  await lostRunner.step({ kind: 'start', actor: 'a' });
  await settlePort(lostRunner, 'a', 1);
  await lostRunner.step({ kind: 'apply', op: 'a:2', result: 'normal' });
  await lostRunner.step({ kind: 'ack', op: 'a:2', delivery: 'lost' });
  await lostRunner.step({ kind: 'crash', actor: 'a' });
  const lostAck = await finishNormally(lostRunner);
  requireCondition(
    lostAck.result.effects === 0 &&
      (
        lostRunner.snapshot().resources[0]?.value as {
          status?: string;
        }
      ).status === 'claimed' &&
      lostRunner.snapshot().actors.find((actor) => actor.id === 'a')?.calls === 2,
    'Lost acknowledgement/crash did not retain the durable claim.',
  );
  const deadlineRunner = await Simulator.create(defaultFixture({ actors: ['a'], restarts: 0 }), identity);
  await deadlineRunner.step({ kind: 'start', actor: 'a' });
  await settlePort(deadlineRunner, 'a', 1);
  await deadlineRunner.step({ kind: 'apply', op: 'a:2', result: 'normal' });
  await deadlineRunner.step({ kind: 'advance', to: 20 });
  await deadlineRunner.step({ kind: 'ack', op: 'a:2', delivery: 'normal' });
  await deadlineRunner.step({ kind: 'resume', actor: 'a' });
  const deadline = await finishNormally(deadlineRunner);
  requireCondition(
    deadline.result.effects === 0 && deadline.result.violations.length === 0,
    'Deadline crossing executed an effect.',
  );
  const staleRunner = await Simulator.create(
    defaultFixture({ actors: ['a'], restarts: 0, staleTarget: true }),
    identity,
  );
  const stale = await finishNormally(staleRunner);
  requireCondition(
    stale.result.effects === 0 && stale.result.violations.length === 0,
    'Stale target executed an effect.',
  );
  const tampered = structuredClone(original);
  tampered.events[0]!.world.now = 999;
  let tamperRejected = false;
  try {
    await replay(tampered, identity);
  } catch {
    tamperRejected = true;
  }
  requireCondition(tamperRejected, 'Tampered trace was accepted.');
  return {
    original,
    alternative,
    minimized: reduced.trace,
    correct,
    lostAck,
    deadline,
    stale,
    summary: {
      injectedDefect: 'unsafe-claim-cas, a test-only broken store; not a production bug',
      search: {
        seed: 17,
        runs: campaign.runs,
        bounds: campaign.bounds,
        setup: 'irrelevant consumer c reads then crashes; the race suffix is seeded exploration',
      },
      replayVerified: true,
      branch: { at, effects: alternative.result.effects, prefixHash: alternative.parent!.prefixHash },
      minimization: {
        tested: reduced.tested,
        transformations: reduced.transformations,
        originalSteps: reduced.originalSteps,
        minimizedSteps: reduced.minimizedSteps,
        stopped: reduced.stopped,
      },
      correct: {
        effects: correct.result.effects,
        incompatibleOriginalChoicesSkipped: skipped,
        freshSearch: { runs: fresh.runs, counts: fresh.counts, bounds: fresh.bounds },
      },
      checks: { lostAckAndCrash: true, deadline: true, staleTarget: true, tamperRejected },
      scope:
        'One synthetic command, bounded actors and crashes, atomic in-memory storage. No AWS, real external effects, model calls, or exhaustive proof.',
    },
  };
}

export type DemoResult = Awaited<ReturnType<typeof demo>>;
