# Controlled command continuations

The simulator separates a durable operation from learning its result. That
separation exposes command races that a test with immediately resolved promises
cannot schedule. The command service runs unchanged. Controlled ports decide
when each awaited operation applies and when the service can continue.

## Real service, controlled ports

A fixture creates one queued command in `MemoryAgentsStore`. Each actor starts a
real `ExecutionCommandService.drain` against that shared store. The service lists
commands, decides whether to claim one, writes the claim with an expected
revision, invokes the effect, and writes a response. Response creation and command
deletion use the store's atomic transaction.

The simulator replaces the service's store methods with gates. A port call saves
an `Operation` and returns a pending promise. The actor pauses at that call. The
scheduler can choose a different actor, move virtual time, apply an operation,
deliver an acknowledgement, resume a continuation, or crash an actor.

`model.ts` calculates enabled choices, invariants, hashes, and result
classification from plain data. `simulator.ts` owns promises, actors, gates, the
store, and the effect ledger. `Simulator.snapshot()` exposes a detached world
after each choice. Every event includes that world, the choice, and observations
produced while the choice ran.

## Apply, acknowledge, and resume

An invoked gate progresses through three separately scheduled decisions:

1. **Apply** executes the port operation. Store writes and external effects become
   visible now. The service still awaits the gate's promise.
2. **Acknowledge** makes the recorded result ready, substitutes a transport error,
   or loses the acknowledgement. No continuation runs in this step.
3. **Resume** resolves or rejects a ready promise. The real service runs until its
   next port call or completion.

Consider actor `a` after it has read the queued command. Applying its claim changes
the durable record to `claimed`. Losing the acknowledgement leaves `a` waiting,
with no ready result to resume. Crashing `a` abandons the promise. A restart actor
begins a new drain, sees the durable claim, and does not execute the effect.

This schedule can end with zero effects and a claimed record. The claim prevents
a duplicate, but it does not guarantee eventual completion. The simulator keeps
that distinction visible in both durable state and result classification.

A transport error is different from a crash. After `ack` with delivery `error`,
`resume` rejects the promise and the service executes its error handling. If the
effect already applied, the effect remains in the ledger even if the service
writes a failed response. A crash runs no rejection handler for the abandoned
continuation.

The gate stores a serializable outcome for the event and a native settlement for
the promise. The native value can be `undefined`; a native error can be an
`AgentsApiError` whose identity matters to service control flow. Saved error text
does not replace that live value.

## Faults and virtual time

The shared fault allowance covers crashes, fail-before application, and error or
lost acknowledgements. Normal application and acknowledgement consume no faults.
`fail-before` applies no write or effect. A crash removes the actor's gates,
including unapplied operations, while preserving writes and effects already
applied. Restart actors become eligible only after a death and start a fresh
drain; they do not recover the dead actor's JavaScript continuation.

Time advances only through explicit `advance` choices. Enabled times include the
next tick and boundaries around the fixture deadline. The service reads this
clock when deciding to claim and again before invoking an effect.

Deadline safety concerns invocation. If a claim's acknowledgement arrives at the
deadline, the service refuses to invoke the effect. If `perform` was already
invoked before the deadline, the simulator can advance time and apply it later.
That delayed application does not violate `deadline-at-invocation`.

## Deterministic schedules and verified replay

Enabled choices are sorted by canonical encoding before selection. The seeded
scheduler usually prefers normal choices. One in twenty selector states allows
the full choice set; `safe` programmatic runs prefer normal choices whenever any
exist. Safe mode can still select a fault or time advance when no normal choice
is enabled. Seeded runs retain both RNG evaluations and the same state advancement.

A trace records what happened instead of relying on the seed alone. Replay
reconstructs a fresh simulator, reruns the recorded choices, and compares every
event through the requested point. Hash checks detect changes to the recorded
chain. Semantic replay detects altered observations even when someone recomputes
the hashes. The CLI verifies the full trace before returning a partial inspection
or branching from an earlier point.

Branching replays an inclusive prefix, optionally applies one selected choice,
then explores a new suffix. Its proof binds the child to the complete root trace
and shared events. Only one root-to-child generation is supported.

Minimization reruns proposed schedules and accepts only the same violation list.
Actor and restart removal each receive one pass. Contiguous choice deletion then
continues to a fixed point or attempt limit. Every proposal uses the current best
trace, so an accepted reduction changes the next proposal.

## Invariants and scope

The model checks five properties:

| Property | Violation condition |
| --- | --- |
| `at-most-once` | More than one effect appears in the ledger. |
| `claim-before-effect` | An effect invocation's actor has no successful applied claim. |
| `deadline-at-invocation` | An effect is invoked at or after its deadline. |
| `stale-target` | An effect is invoked for the fixture's stale execution target. |
| `atomic-response` | A response record and command record coexist in a snapshot. |

The `correct` store keeps its conditional writes. `unsafe-claim-cas` bypasses the
expected-revision check only for claim writes. Two actors can then claim the same
queued command and both invoke an effect. This injected test defect supplies the
demo witness. Other store behavior, including the response transaction, remains
the existing `MemoryAgentsStore` behavior.

The model contains one synthetic command, at most three initial actors, and at
most two restart actors. Consumers await operations sequentially. Storage is
atomic and in memory. Effects are ledger entries, not remote requests. The
simulator excludes requester polling, multiple commands, AWS behavior, model
calls, and late remote application after a client dies. Bounded exploration
covers selected schedules within those limits; no violation is not a proof of
the production system.

## Artifacts and ownership

The CLI coordinates command work and publication. `artifacts.ts` owns accepted
trace shapes, provenance, and JSON I/O. `demo.ts` owns scenarios and their checked
summary. `report.ts` renders HTML from that data without reading files or running
the simulator. The CLI copies brand styles and fonts before writing the report.
The report's browser controls inspect saved events; they do not run new branches.

Simulator creation clones the fixture and provenance. Getters, snapshots, events,
and traces expose detached data. Artifact parsing returns the supplied object,
and minimization can return its input trace if no candidate succeeds. Callers
must not assume that every helper returns a separate object.

Source fingerprinting includes all files in this directory. Documentation edits
therefore require fresh artifacts, just as simulator edits do. The
[reference](reference.md#provenance) lists the exact identity inputs and error rules.
