# Inspect command schedules

Create a recorded command race, replay it, and change one scheduling decision.
The simulator runs the real `ExecutionCommandService.drain` against controlled
ports and an in-memory store. It needs no AWS account or model calls.

Run these commands from the repository root after `npm ci`. Keep the same source
files and runtime throughout the walkthrough. Every file in `testing/time-travel`,
including these documents, contributes to the replay fingerprint. After editing
one, generate new artifacts. See [provenance](reference.md#provenance).

## Create the demonstration

Create a fresh working directory. The commands below create new children inside
it because existing output files and directories are rejected.

```bash
work=$(mktemp -d "${TMPDIR:-/tmp}/rat-command-travel.XXXXXX")
npm run sim:commands -- demo --out "$work/demo"
```

The result includes `replayVerified: true` and four successful `checks`. The
command writes seven traces, `summary.json`, and an interactive `index.html` with
local styles and fonts. Open the report in a browser. On macOS, run:

```bash
open "$work/demo/index.html"
```

The report compares two effects in **Original** with one in **Branch** and
**Correct**. Select a trace, then select an event or move the timeline. The durable
records and effect ledger show the state after that event.

The original uses `unsafe-claim-cas`, an intentionally broken test store. This
demonstrates a duplicate-effect witness, not a production bug. The demo finds its
race suffix through seeded exploration after consumer `c` reads and crashes.

## Replay the recorded race

```bash
npm run --silent sim:commands -- replay "$work/demo/original.json" --json
```

The result has `verified: true`, two entries in `world.effects`, and an
`at-most-once` violation. Replay runs the recorded choices through the service and
compares the resulting events. Matching hashes alone do not establish replay.

## Inspect a boundary

```bash
npm run --silent sim:commands -- inspect "$work/demo/original.json" --at 1 --json
```

The result has `at: 1`. Actor `c` is waiting at its first store call, and `enabled`
includes `{"kind":"crash","actor":"c"}`. An event point is inclusive. Point `1`
means after event 1; point `0` means before any choices.

Inspection verifies the entire saved trace before returning this partial view.
An invalid later event still causes an error.

## Branch from that boundary

Copy the enabled crash choice into a new branch:

```bash
npm run sim:commands -- branch "$work/demo/original.json" --at 1 \
  --choice '{"kind":"crash","actor":"c"}' --seed 91 --steps 80 \
  --out "$work/branch.json"
```

The new trace preserves event 1. Its second event crashes `c`, and the seed selects
the remaining suffix. The result includes a `parent` proof that identifies the
original trace and preserved prefix. The original file is unchanged.

Replay the branch with its parent:

```bash
npm run --silent sim:commands -- replay "$work/branch.json" \
  --parent "$work/demo/original.json" --json
```

The result has `verified: true`. Keep the parent file with the branch. Replay,
inspection, and minimization require it. Only one branch generation is supported,
so create each branch from a root trace.

## Reduce the failing schedule

```bash
npm run sim:commands -- minimize "$work/demo/original.json" \
  --attempts 300 --out "$work/minimal.json"
```

The output reports fewer `minimizedSteps` than `originalSteps`, includes
`remove actor c` in `transformations`, and retains the `at-most-once` violation.
Each accepted candidate has been rerun through the service. The stop reason
describes the bounded reduction, not a globally smallest witness.

## Explore fresh schedules

```bash
npm run sim:commands -- explore --seed 23 --runs 3 --steps 40 --out "$work/search"
```

The default store enforces compare-and-swap. The result reports counts by status
and the requested bounds. The directory contains `summary.json` and either
`failure.json` or `last.json`. Use the returned `artifact` path for replay.
`failure.json` means the search stopped at its first invariant violation.

To explore the injected defect, run another search in a new directory:

```bash
npm run sim:commands -- explore --fault-model unsafe-claim-cas \
  --seed 17 --runs 100 --steps 80 --out "$work/unsafe-search"
```

A search with no violation only describes the schedules it tried. It does not
prove safety for all schedules.

See the [command and artifact reference](reference.md) for every flag and result,
[architecture](architecture.md) for fault and continuation semantics, and
[contributor guide](CONTRIBUTING.md) to add scenarios.
