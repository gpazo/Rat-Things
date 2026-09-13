# Durable work with Sessions

A Session owns multi-turn agent work. Its Agent configuration is snapshotted at
creation; Turns record execution, and Items retain messages and tool activity.
The API, harness and storage run in the deployment's AWS account.

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

DynamoDB holds owner-scoped resource revisions and conditional-write fences;
encrypted S3 holds full state and content. A durable Session outbox orders accepted
input, steering and function results. A private runtime journal connects the
Session to its harness and saves observations so reconnect does not require a
second public lifecycle.

Saved history and artifacts are independent of the lifetime of a MicroVM. The
execution environment can expire or become unavailable; that does not remove
already saved Items. An unavailable environment may prevent continued execution.
Inspect the Session and Turn errors instead of assuming the harness is still live.

## Invariants

- The authenticated principal owns the Session. Input cannot select another owner.
- Session events with the same idempotency key and body are not submitted twice.
- Input ordering, terminal Turn materialization and provider delivery use durable
  conditional writes and separate execution/delivery work groups.
- The Agent's declared tools, deployment policies and credentials bound its
  authority. A tool denial cannot create an approval that widens authority.
- Deleting a Session fences further input and closes its private harness.

The former named conversation mailbox, organization/search routes and public Run
API are retired. Application titles can use Session metadata; provider thread
continuity uses owned Agent bindings described in [provider bindings](schedules.md#provider-bindings).
