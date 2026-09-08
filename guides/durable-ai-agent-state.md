# How to preserve AI-agent context and files across restarts

Preserving an AI agent across restarts requires more than saving chat messages. Store the accepted
request, transcript, execution events, generated files, workspace bytes, and native agent-thread
state outside the worker; serialize turns that share a workspace; and make recovery conditional on
the exact execution generation. Then a replacement worker can continue from durable evidence
without pretending that an uncertain external side effect never happened.

> **Short answer:** transcripts preserve meaning, workspace snapshots preserve work, and fenced
> execution state prevents two workers from owning the same conversation at once.

## Separate the kinds of state

“Agent memory” often combines several systems with different correctness requirements:

| State | Why it matters | Suitable durable home |
| --- | --- | --- |
| Accepted request | Proves what work was authorized | Immutable object plus bounded receipt |
| Conversation transcript | Lets a later turn understand prior decisions | Durable message bodies and searchable metadata |
| Execution events | Explains progress, tools, and failure | Append-only event log |
| Native model thread | Preserves provider-specific conversational continuity | Private, conversation-scoped state |
| Workspace files | Preserves edits, dependencies, and generated work | Versioned or checksummed durable filesystem |
| User-facing artifacts | Makes outputs discoverable independently of the worker | Owner-scoped object catalog |
| External side effects | Determines whether a write is safe to retry | Tool ledger plus provider reconciliation |

Saving only the final answer loses intermediate evidence and files. Saving only a VM snapshot ties
the conversation to one piece of compute. Saving only a transcript may let the model discuss old
work while silently missing the actual checkout that produced it.

## Make the mailbox authoritative

A queue should wake processing; it should not be the only record that work exists. Queue messages
can be delivered more than once, delayed, or consumed immediately before a worker fails.

Rat Things first records each accepted conversation input as one durable Run, attaches it to a
mailbox turn, and then sends a queue wake-up. A repeated wake repairs the attach/enqueue crash window
without creating a second semantic Run. Full bodies and results live in encrypted S3 while DynamoDB
contains bounded coordination records and indexes.

This design makes the durable mailbox—not SQS and not a running MicroVM—the source of truth. The
complete state layout is documented under [how conversation durability
works](../docs/conversations.md#how-durability-works).

## Use an explicit recovery algorithm

A replacement path should be deterministic enough to test without asking the model what probably
happened:

1. Write the immutable request body to durable storage.
2. Conditionally reserve one Run and attach it to one mailbox turn before returning a receipt.
3. Send a wake-up message. If enqueueing fails, retry the wake—not the semantic request.
4. Acquire a generation-bound conversation lease before restoring private state.
5. Mount the last committed workspace and native thread, then dispatch the reserved Run.
6. Commit transcript, tool ledger, artifacts, and workspace only while the same lease generation is
   current.
7. If the worker disappears, expire its lease, quarantine late writes, and let a successor acquire a
   new generation.
8. Before repeating an external mutation with an unknown outcome, reconcile it with the provider or
   a provider idempotency key.

```text
client -> durable request + Run receipt -> queue wake
                         |                    |
                         v                    v
                  authoritative mailbox -> lease generation N
                                               |
                                  restore -> execute -> commit
                                               |
                               missing heartbeat or dead worker
                                               v
                                  lease generation N+1 -> restore
```

Amazon SQS documents that standard queues use at-least-once delivery, so duplicate wake-ups must be
expected rather than treated as exceptional. The durable Run identity is what prevents those wakes
from becoming duplicate work.

## Fence ownership before mounting a workspace

Two workers must not open and modify the same conversation state concurrently. Use a renewable
lease tied to an immutable execution generation, and require that token on every mutating turn
operation.

Rat Things serializes turns within one conversation while allowing unrelated conversations to run
in parallel. The lease also fences filesystem ownership: only the current MicroVM may mount and
open that conversation's native Codex state. A stale or superseded worker cannot update active
state merely because it finishes later.

This distinction becomes especially important during heartbeat repair. A missing heartbeat is a
liveness signal, not proof that an earlier external API call failed.

## Restore both the workspace and agent thread

With S3 Files enabled, Rat Things assigns each conversation a private filesystem root derived from
its durable identity. Before a turn, orchestration restores native Codex state and exact workspace
bytes. After a successful turn, committed state remains available when the same MicroVM resumes or
when replacement compute is required.

Generated deliverables use a separate retained-artifact contract. An agent writes regular files
beneath `.rat-things/artifacts/`; trusted orchestration validates paths, hashes the bytes, uploads
immutable objects, and commits a current path catalog. A gracefully stopped or failed turn can
retain partial files when trusted finalization completes. An abrupt termination or failed
finalization can lose uncommitted files; the previous committed catalog remains the recovery source. Read [durable files and share links](../docs/durable-files.md)
for the exact limits and commands.

## Continue a durable thread

Use one stable thread name for related work:

```bash
npm run rat-things -- handoff \
  --thread release-investigation \
  --sandbox workspace-write --no-network \
  "Create .rat-things/artifacts/reports/release.md with a release-readiness checklist."

npm run rat-things -- chat \
  --thread release-investigation \
  "Read .rat-things/artifacts/reports/release.md, add a rollback checklist, and save it."
```

The second turn selects the same durable conversation. When possible, Rat Things resumes its
suspended MicroVM and native Codex thread. When replacement is necessary, the transcript remains
durable and S3 Files can restore the private state and workspace.

For automation, add a stable idempotency key to every semantic input. Preserve the Run receipt and
wait for the message to be consumed, the Run to become terminal, and the conversation to return to
idle before treating generated files as committed.

## Do not blindly replay uncertain writes

A worker can lose contact after an external service accepted a request but before the local ledger
recorded success. Automatically replaying the call may create a duplicate issue, payment, comment,
or deployment.

Record every connected-service tool call durably and distinguish a known failure from an unknown
outcome. After interruption or replacement, inspect the ledger and provider state before retrying
a consequential operation. If the provider offers idempotency keys, derive one from the semantic
operation rather than from a transient worker attempt.

Rat Things' delivery fence similarly treats an ambiguous provider response as
`outcome_unknown`; no local database pattern can manufacture exactly-once behavior from an API
that supplies no idempotency mechanism.

## Current boundaries

Retention is finite, and a durable mailbox is not an archival backup. Rat Things does not provide
cross-Region disaster recovery, sustained-concurrency guarantees, or production-grade untrusted
tenant isolation. Choose retention and backup policy separately from worker continuity.

## A practical durability checklist

Before calling an agent workflow durable, verify that it can answer all of these questions:

1. Can the client recover the accepted request and receipt after disconnecting?
2. Can another worker acquire ownership without racing the original worker?
3. Are transcript, native thread, workspace, and deliverables restored independently?
4. Can the operator distinguish finalized partial files from uncommitted changes after failure?
5. Can the operator distinguish a failed external write from an unknown outcome?
6. Can results be inspected without a live worker?
7. Are retention, deletion, encryption, and owner boundaries explicit?

Rat Things implements one answer to this checklist. Start with [durable
conversations](../docs/conversations.md), use the [durable file catalog](../docs/durable-files.md) for deliverables, and enable S3 Files
when the workflow also needs native thread and exact workspace continuity.

## Sources

- [Amazon SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)
- [Rat Things conversation state and validation](../docs/conversations.md)
- [Rat Things durable-file commit contract](../docs/durable-files.md)
- [Rat Things security boundaries](../docs/security.md)
