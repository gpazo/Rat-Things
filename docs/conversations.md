# Durable work with Sessions

A Session owns multi-turn agent work. Its Agent configuration is snapshotted at
creation; Turns record execution, and Items retain messages and tool activity.
The API, harness and storage run in your selected workspace: on
[this computer](local-workspace.md) or in your AWS account.

```bash
rat-things sessions create --agent-id agent_example --input "Review the proposal."
rat-things sessions send sess_example --input "Include the operating costs."
rat-things sessions turns sess_example
rat-things sessions items sess_example
```

Use [Agents API](agents-api.md) for SDK request shapes, streaming, function
results, environments and credentials. The console exposes Sessions, Agents,
environment templates and Vaults. It restores saved Items after reload and accepts
new input or cancellation through Session events.

## How durability works

In AWS, DynamoDB holds owner-scoped resource revisions and conditional-write fences;
encrypted S3 holds full state and content. A durable Session outbox orders accepted
input, steering and function results. A private runtime journal connects the
Session to its harness and saves observations so reconnect does not require a
second public lifecycle.

Codex and Pi Durable use this same Session lifecycle. Codex restores its native
journals from configured durable storage. Pi Durable restores committed tasks,
pending function calls, tool results, and child relationships through Rat Things'
native state store. Recovery confirms the prior worker has stopped before giving
a replacement ownership; old owners cannot continue writing. See
[runtime durability](agent-runtimes.md#how-pi-durable-and-rat-things-work-together).
The local workspace uses the same Session service and outbox with an encrypted
SQLite resource store. Its native harness journal retains saved Items across
restarts. A Turn interrupted by a stopped local service is marked failed instead
of being replayed; new input continues the Session. Local and AWS workspaces keep
separate histories.

Saved history and artifacts are independent of the lifetime of a MicroVM. The
execution environment can expire or become unavailable; that does not remove
already saved Items. An unavailable environment may prevent continued execution.
Inspect the Session and Turn errors instead of assuming the harness is still live.

## Explore a different direction

A fork starts a new Session from an idle source's latest terminal root Turn. The
child retains conversation context and receives an independent copy of the
workspace. Its public history starts fresh and its lineage points back to the
source. Deleting either Session does not delete the other's files or recovery
history. Choosing a preferred child is an application decision; it does not merge
changes back into the source.

Forking a live source checkpoints it and stops its worker. The next source input
resumes its conversation and files. This path requires opt-in checkpoints with
persistent S3 Files storage; automatic idle checkpoint policies remain separate.
See [fork semantics](agents-api.md#fork-a-session) and try the
[two-theme demo](session-fork-demo.md).

## Invariants

- The authenticated principal owns the Session. Input cannot select another owner.
- Session events with the same idempotency key and body are not submitted twice.
- Input ordering, terminal Turn materialization and provider delivery use durable
  conditional writes and separate execution/delivery work groups.
- The Agent's declared tools, deployment policies and credentials bound its
  authority. A tool denial cannot create an approval that widens authority.
- Deleting a Session fences further input and closes its private harness.

Application titles can use Session metadata; provider thread
continuity uses owned Agent bindings described in [provider bindings](schedules.md#provider-bindings).
