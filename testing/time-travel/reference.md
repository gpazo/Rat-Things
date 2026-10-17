# Command and artifact reference

The entry point is `npm run sim:commands -- <command> [options]`. Replay,
inspection, branching, and minimization take exactly one positional trace path.
Demo and exploration take none. Unknown options, repeated options, and missing
option values are errors. Options use `--name value`, with the exception of
`--json`, which takes no value.

## Commands

| Command | Required arguments | Optional flags | Output |
| --- | --- | --- | --- |
| `demo` | `--out DIRECTORY` | `--json` | New directory with seven traces, summary, and browser report. |
| `explore` | `--out DIRECTORY` | `--seed`, `--runs`, `--steps`, `--fault-model`, `--actors`, `--restarts`, `--faults`, `--json` | New directory with summary and first failing or last trace. |
| `replay` | `TRACE` | `--parent`, `--json` | Verified final world, enabled choices, and result. |
| `inspect` | `TRACE --at EVENT` | `--parent`, `--json` | Verified world, enabled choices, and result at the event point. |
| `branch` | `TRACE --at EVENT --out FILE` | `--choice`, `--seed`, `--steps`, `--parent`, `--json` | New trace file and its result and parent proof. Further branching from a child is rejected. |
| `minimize` | `TRACE --out FILE` | `--attempts`, `--parent`, `--json` | New trace file and reduction summary. The input must have a violation. |

`--parent FILE` is required when the input has a parent proof and rejected when
it does not. The parent must be a root trace. A child cannot be branched again.

All commands print JSON on success. The default output is indented. `--json`
prints compact JSON and changes errors to `{"error":"message"}` on stderr.
Without `--json`, errors use `Simulation error: message`. Errors exit with status
1. A successful exploration that finds a violation still exits with status 0.
`npm run --silent sim:commands -- ... --json` suppresses npm's command banner.

## Flags and bounds

Numeric flag values contain decimal digits only. The bounds below are inclusive.

| Flag | Commands | Default | Accepted values |
| --- | --- | --- | --- |
| `--out` | `demo`, `explore`, `branch`, `minimize` | Required | Path of at most 4,096 characters. Resolved against the current directory. |
| `--seed` | `explore`, `branch` | `17` | `1` through `4294966295`. Exploration uses seed plus run index. |
| `--runs` | `explore` | `100` | `1` through `1000`. Stops earlier on a violation. |
| `--steps` | `explore`, `branch` | `100` | `1` through `1000`. Per-run limit for exploration; suffix allowance for branching. |
| `--fault-model` | `explore` | `correct` | `correct` or `unsafe-claim-cas`. |
| `--actors` | `explore` | `3` | `2` or `3`, selecting `a`, `b`, then `c`. |
| `--restarts` | `explore` | `1` | `0` through `2`. Each restart actor starts at most once, after an actor dies. |
| `--faults` | `explore` | `3` | `0` through `10`. Shared allowance for crashes, fail-before application, and error or lost acknowledgements. |
| `--at` | `inspect`, `branch` | Required | `0` through the input event count. The point is inclusive. |
| `--choice` | `branch` | Seed selects the suffix | A JSON choice from the inspected world's `enabled` list. Runs first within the suffix allowance. |
| `--attempts` | `minimize` | `300` | `1` through `2000`. Counts attempted candidate reruns. |
| `--parent` | `replay`, `inspect`, `branch`, `minimize` | Absent | Root trace path required by the input's parent proof. |
| `--json` | All | Absent | Boolean switch. |

A branch's total step limit is `--at + --steps`, at most 2,000. The optional first
choice consumes one of those suffix steps. The default fixture has deadline 20,
maximum virtual time 40, and `staleTarget: false`. Those settings have no CLI flags.

## Choices

Choice objects contain exactly the fields shown below. Shape validation does not
make a choice enabled; the scheduler also checks the current world.

| Shape | Meaning |
| --- | --- |
| `{"kind":"start","actor":"a"}` | Start a fresh drain and wait for its first boundary or completion. |
| `{"kind":"apply","op":"a:1","result":"normal"}` | Apply the pending port operation. `fail-before` rejects before application. |
| `{"kind":"ack","op":"a:1","delivery":"normal"}` | Make the applied outcome ready. `error` substitutes a transport error; `lost` leaves the continuation parked. |
| `{"kind":"resume","actor":"a"}` | Deliver a ready outcome and run to the next boundary or completion. |
| `{"kind":"crash","actor":"a"}` | Abandon the actor and its pending operations. |
| `{"kind":"advance","to":20}` | Move the virtual clock to an enabled later time. |

Actor names are `a`, `b`, `c`, `restart-1`, and `restart-2`. An operation ID combines
one actor name, a colon, and an ordinal from 1 through 9,999. Parsed `advance.to`
values range from 1 through 1,000. Enabled times are the current time plus one,
deadline minus one, deadline, or deadline plus one, within the fixture's maximum.

## Results

Every trace result has `status`, `violations`, `steps`, and `effects`. Classification
uses the following priority:

1. `violation` when any invariant fails.
2. `completed` when every actor is done, dead, or an unused restart with no dead
   actor that could enable it. A drain that throws is done. Completion does not
   imply that the command succeeded or that an effect occurred.
3. `parked` when no choices are enabled.
4. `budget-exhausted` when the step limit is reached and choices remain.
5. `parked` for a partial trace stopped before its limit with choices remaining.

Completion and lack of enabled choices take precedence at the exact step limit.
`inspect.result` describes the partial world, using the saved trace's step limit.

Invariant names are `at-most-once`, `claim-before-effect`, `deadline-at-invocation`,
`stale-target`, and `atomic-response`. Every violation identifies `command`.
Their checks are described in [architecture](architecture.md#invariants-and-scope).

Exploration reports `runs`, status `counts`, `bounds`, `artifact`, and `scope`.
It saves the first failing trace as `failure.json`; otherwise it saves the last
run as `last.json`. The same output is saved in `summary.json`.

Replay and inspection return `verified`, `at`, `world`, `worldHash`, `enabled`,
and `result`. Branching returns `artifact`, `result`, and `parent`. Minimization
returns `tested`, `accepted`, `transformations`, `originalSteps`, `minimizedSteps`,
`stopped`, `scope`, `artifact`, and `result`.

Minimization first tries truncation after the first violation, then one pass of
actor removal and restart removal. It then tries contiguous choice deletion.
Candidates must reproduce the same violation list. `attempt-budget` means the
attempt limit was reached. `choice-deletion-fixed-point` means no remaining
contiguous deletion was accepted after the workload pass. Neither stop reason
claims a global minimum.

The demo summary records the injected defect, search, replay verification, branch,
minimization, correct-store comparison, extra checks, and bounded scope. Its
stdout result also includes `directory` and `report`. Demo traces are
`original.json`, `branch.json`, `minimized.json`, `correct.json`, `lost-ack.json`,
`deadline.json`, and `stale.json`.

## Artifact format

Trace files use format 1. JSON reads and writes are limited to 32 MiB. Writes use
two-space indentation and a final newline. Files are created exclusively; an
existing file causes `EEXIST`. Demo and exploration require a new output directory
whose parent already exists. Publication is sequential and not atomic. A failure
can leave the files written before it.

| Trace field | Content and accepted bounds |
| --- | --- |
| `format` | Literal `1`. |
| `fixture` | `actors`, `restarts`, `deadline`, `staleTarget`, `faultModel`, `maxFaults`, `maxTime`. |
| `provenance` | `sources`, `runtime`, and `git`. |
| `seed` | Integer from 1 through 4,294,967,295. This artifact bound is wider than the CLI's starting seed bound. |
| `stepLimit` | Integer from 1 through 2,000. |
| `events` | At most `stepLimit` events. |
| `result` | `status`, at most five `violations`, `steps` from 0 through 2,000, and `effects` from 0 through 5. |
| `parent` | Optional `digest`, `at`, and `prefixHash`. `at` ranges from 0 through the child event count. |

The fixture accepts one to three distinct actors drawn from `a`, `b`, and `c`.
It accepts zero to two restarts, deadline 1 through 500, maximum time from deadline
through 1,000, and zero to ten faults. `staleTarget` is a boolean. `faultModel` is
`correct` or `unsafe-claim-cas`. Single-actor fixtures can result from minimization
or programmatic scenarios even though exploration's CLI requires at least two.

Each event contains `index`, `choice`, `observations`, `world`, `worldHash`,
`previousHash`, and `hash`. Indexes range from 1 through 2,000. Each event accepts
at most 20 observations. A world records `now`, `faults`, durable `resources`,
`actors`, `gates`, `effects`, `claims`, and port `invocations`.

The parser checks required and unexpected fields on the trace, fixture,
provenance, runtime, event, result, parent proof, and choice objects. It does not
deeply validate every observation or world field. Replay validates the recorded
semantics by comparing the reconstructed events.

Hashes are lowercase SHA-256 hex strings with 64 characters. Canonical encoding
sorts object keys and preserves array order. The root hash covers format, fixture,
and source/runtime identity. Each event hash covers its body, including the prior
hash and world hash. The parent proof covers the entire parent trace digest, the
shared prefix hash, matching fixture and identity, and identical shared events.

Returned outcomes distinguish `{"type":"undefined"}` from
`{"type":"json","value":null}`. Thrown outcomes save error name and message;
`AgentsApiError` also contributes status, code, and param. Live promises retain the
native value or error used by the service.

## Provenance

Verified replay requires an exact match for the source path/hash map and runtime
identity. The fingerprint includes every file recursively under `src` and
`testing/time-travel`, plus these files:

- `tests/agents/fixtures.ts`
- `package-lock.json`
- `package.json`
- `tsconfig.json`
- `spec/schemas/agents-api.schema.json`

Harness documentation is included. Editing a document invalidates artifacts
generated before the edit. The runtime records Node version, tsx package version,
platform, and architecture. Git revision is supplemental; different commits with
identical fingerprinted bytes and runtime can replay each other's root traces.
A branch's whole-parent digest still requires the exact parent artifact.

The source map accepts at most 5,000 entries with paths shorter than 500
characters. Runtime strings are shorter than 100 characters. The git string is
shorter than 1,000 characters and is `unavailable` when revision lookup fails.

## Verification and errors

The CLI reads and validates the input and required parent, then replays the full
trace before replay, inspection, branching, or minimization proceeds. Inspection
and branching cannot hide an invalid suffix. Parent verification also replays the
root trace. No command offers a provenance bypass.

| Error | Condition |
| --- | --- |
| `Unknown or repeated option ...`, `Missing value ...` | Invalid command syntax. |
| `--... must be an integer`, `--... must be between ...` | Invalid numeric flag at the point that command reads it. |
| `Trace is not valid JSON`, `Trace exceeds 32 MiB` | Invalid input encoding or size. |
| `Unexpected or missing artifact fields`, `Invalid ...` | Invalid artifact or choice shape and bounds. |
| `Source/runtime provenance mismatch` | Source files or runtime differ. |
| `Trace integrity failure at event ...` | Event index, hash chain, or world hash differs. |
| `Replay divergence at event ...`, `Replay result divergence` | Re-execution differs from the saved event or result. |
| `Illegal choice at event ...` | A choice is not enabled at that boundary. |
| `Parent prefix proof mismatch` | Parent identity or shared prefix differs. |
| `Further branching is unsupported` | The input already has a parent. |
| `Minimization requires a failing trace` | The input has no invariant violations. |
| `EEXIST`, other filesystem errors | The destination exists, a parent is absent, or another filesystem operation fails. |

Validation is command-specific and lazy. For example, a missing input file fails
before inspection validates `--at`, and exploration runs before it validates
`--out`. Earlier errors take precedence. Input validation and replay failures do
not create a branch or minimized output file.
