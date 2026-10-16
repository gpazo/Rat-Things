# Inspect command schedules

Run the self-checking demonstration from the repository root. Choose an output
directory that does not exist.

```bash
npm run sim:commands -- demo --out /tmp/command-demo
open /tmp/command-demo/index.html
```

The report shows the recorded original, a branch, and a correct-store comparison.
Select a trace and an event to see durable records and the external effect ledger.
The original uses `unsafe-claim-cas`, an injected test-store defect. It is not a
production bug. The race suffix comes from seeded exploration after an irrelevant
consumer reads and crashes. The demonstration verifies replay, a shared branch
prefix, actor removal during minimization, lost acknowledgements, crashes,
deadlines, stale targets, and tamper rejection.

To search fresh schedules, use bounded exploration. The default store preserves
compare-and-swap transactions.

```bash
npm run sim:commands -- explore --seed 17 --runs 100 --steps 80 --out /tmp/command-search
npm run sim:commands -- replay /tmp/command-search/last.json --json
npm run sim:commands -- inspect /tmp/command-demo/original.json --at 17 --json
```

Exploration saves `failure.json` if it finds a violation, or `last.json` otherwise.
Use `--fault-model unsafe-claim-cas` to explore the injected defect. Optional
`--actors` accepts 2 or 3, `--restarts` accepts 0 through 2, and `--faults` accepts
0 through 10. Search limits are 1,000 runs and 1,000 steps per run. Seed values
range from 1 through 4,294,966,295. Each result distinguishes a violation,
completion, parked continuations, and an exhausted step budget. No bounded search
establishes an exhaustive guarantee.

To choose a counterfactual, copy an enabled choice from inspection into `--choice`.
The chosen event runs first. The seed selects the remaining suffix. `--at 0`
branches from the initial fixture. Other event points are inclusive.

```bash
npm run sim:commands -- branch /tmp/command-demo/original.json --at 1 \
  --choice '{"kind":"crash","actor":"c"}' --seed 91 --steps 80 --out /tmp/branch.json
npm run sim:commands -- replay /tmp/branch.json --parent /tmp/command-demo/original.json --json
npm run sim:commands -- minimize /tmp/command-demo/original.json --attempts 300 --out /tmp/minimal.json
```

Only one branch generation is supported: create branches from root traces.
Branched artifacts require the root trace as `--parent` for replay, inspection,
and minimization. The parent digest and complete shared event prefix must match.
Further branching is unsupported until the harness can verify an ancestor chain.
A branch cannot exceed 2,000 total events. Minimization reruns candidates through
the real service. It attempts actor removal, restart removal, then contiguous
choice deletion. The report states its attempt bound and the transformations it
accepted. A fixed point applies to choice deletion after the workload pass.

All artifact writes create new files. Existing paths fail. `--json` produces one
machine-readable result or error. Use `npm run --silent sim:commands -- ... --json`
to suppress npm's own command banner. Input artifacts are limited to 32 MiB.
Verified replay requires identical source bytes, lockfile, Node version, tsx
version, platform, and architecture. Git revision is supplemental metadata.
A different commit with identical relevant bytes does not invalidate replay.

The harness invokes `ExecutionCommandService.drain` and the existing atomic
`MemoryAgentsStore`. Application, acknowledgement, and continuation are separate
choices. A continuation runs until its next port call or completion. A crash
abandons its parked promise. A restarted actor begins a fresh drain against the
same durable records. An applied write or effect survives a lost acknowledgement.
A fail-before choice applies neither. A returned error resumes the real service's
error handling, which differs from death.

The model covers one synthetic command and sequential awaits per consumer.
It cancels operations that were invoked but not applied before a crash. It does
not model late remote application after client death, requester polling, multiple
commands, AWS behavior, or real external effects. Deadline safety is checked at
`perform` invocation, so transport delay after invocation can cross the deadline.
The claim provides at-most-once effect acceptance, without unconditional liveness.

Run focused verification with:

```bash
npx vitest run tests/simulation/time-travel.test.ts tests/simulation/time-travel-cli.test.ts --pool=forks --maxWorkers=1 --isolate
npm run typecheck
```
