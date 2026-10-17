# Extend command scenarios

Add a scenario with the existing `Fixture` and `Choice` types before changing the
simulator's vocabulary. A controlled schedule often expresses a new race without
a new operation or scheduler rule.

## Find the code to change

| Module | Responsibility |
| --- | --- |
| `model.ts` | Plain types, fixture defaults, enabled choices, invariants, result priority, canonical hashing, and deterministic selection. |
| `simulator.ts` | Live actor and gate state, native promises, service ports, operation application, snapshots, replay, branching, exploration, and minimization. |
| `artifacts.ts` | Parsing unknown choices and traces, artifact bounds, source/runtime provenance, and create-only JSON I/O. |
| `demo.ts` | The demonstration's schedules, assertions, and summary. `DemoResult` is inferred from `demo`. |
| `report.ts` | Pure HTML rendering from `DemoResult`, with browser controls for saved data. |
| `cli.ts` | Argument syntax, lazy option validation, replay preflight, dispatch, stdout/stderr, and file/asset publication order. |

Keep calculation helpers private unless a caller outside their module needs
them. Keep live store and promise mutations in `Simulator`. The production
service belongs in `src/core/execution-command-service.ts`; the simulator imports
it unchanged.

## Add a scheduled scenario

Create a test under `tests/simulation/`. This complete example uses existing
choices to apply a read, crash before its acknowledgement, and let a fresh actor
finish the command:

```ts
import { expect, it } from 'vitest';
import { defaultFixture, type Provenance } from '../../testing/time-travel/model.js';
import { Simulator } from '../../testing/time-travel/simulator.js';

const provenance: Provenance = {
	sources: {},
	runtime: { node: 'test', tsx: 'test', platform: 'test', arch: 'test' },
	git: 'test',
};

it('starts a fresh drain after a crash before claim', async () => {
	const runner = await Simulator.create(
		defaultFixture({ actors: ['a'], restarts: 1, maxFaults: 1 }),
		provenance,
	);
	await runner.step({ kind: 'start', actor: 'a' });
	await runner.step({ kind: 'apply', op: 'a:1', result: 'normal' });
	await runner.step({ kind: 'crash', actor: 'a' });

	const trace = await runner.run(91, 80, true);
	expect(trace.result).toMatchObject({ status: 'completed', effects: 1, violations: [] });
	expect(runner.snapshot().effects).toEqual([
		{ command: 'command', actor: 'restart-1', invokedAt: 0, appliedAt: 0, deadline: 20 },
	]);
	expect(runner.snapshot().actors).toContainEqual({ id: 'a', status: 'dead', calls: 1 });
});
```

Use explicit `step` calls for the boundary under test. Use `run` for a suffix when
its individual choices do not matter to the assertion. Assert a concrete effect,
resource, completion, or violation. The seed does not replace those expectations.
For saved schedules, also assert verified replay with the same provenance.

## Add a port operation only when needed

If a scenario needs a service port operation the simulator cannot represent,
update these responsibilities together:

1. Add the operation's data to `Operation` in `model.ts`.
2. Adapt the service port in `Simulator.start` so it calls `invoke` with that data.
3. Interpret the operation in `Simulator.apply`. Retain the separate application,
   acknowledgement, and continuation steps.
4. Include its observable result in the existing snapshot or outcome model.
   Preserve native error objects and distinguish `undefined` from JSON `null`.
5. Add any relevant invariant in `violations` and a focused schedule test.
6. Verify replay of the resulting trace and the fault boundaries around the new
   operation.

Only extend `Choice`, `enabled`, and `parseChoice` when the scheduler needs a new
kind of decision. A new port operation can usually use the existing apply, ack,
and resume choices. A new violation property also needs the artifact parser's
accepted property list and result tests.

## Preserve contracts during refactors

Keep canonical choice sorting and RNG state advancement unchanged. Preserve result
priority when completion, a parked continuation, and the step limit coincide.
Do not move numeric or output-path validation ahead of existing reads or work;
that changes which error occurs first. Keep the CLI's full replay before partial
inspection or branching.

Generate each minimization proposal from the current accepted trace. Precomputing
all candidates changes later proposals after an earlier reduction succeeds.
Treat the current one-generation parent limit as part of the contract.

Keep JSON and asset writes in their current order. They create files exclusively
and are not an atomic publication. Rendering HTML must remain a pure calculation;
the CLI owns copying brand assets and writing `index.html`. Read
[`BRAND.md`](../../BRAND.md) before changing report appearance.

The fixed-provenance test in
[`time-travel-baseline.test.ts`](../../tests/simulation/time-travel-baseline.test.ts)
pins hashes of every complete demo trace and its summary. For a behavior-preserving
refactor, keep those literal expectations unchanged. A mismatch needs an explained
behavior difference, not refreshed values.

## Run verification

Run the focused suite and type checker from the repository root:

```bash
npx vitest run tests/simulation/time-travel*.test.ts --pool=forks --maxWorkers=1 --isolate
npm run typecheck
```

Run `npm run check` after code changes, as required by the repository guide. Its
packaging prerequisites are described in [contributor verification](../README.md).
Ordinary tests do not provision Lambda MicroVMs.

After all source and documentation edits, generate a fresh demo with the
[walkthrough](README.md). Verify replay, inspect a boundary, branch with its root
parent, and minimize the witness. For report changes, open `index.html` and check
trace selection, event buttons, timeline, previous/next controls, counts, and
download links. Keep validation results in the commit or PR description.

Every file in `testing/time-travel`, including documentation, is fingerprinted.
An edit here makes older artifacts fail verified replay. Keep generated files
outside this directory so they do not become new fingerprint inputs.
