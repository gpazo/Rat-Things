# Durable conversations

Rat Things has a provider-neutral persistence model for long-running conversations. It adopts the
durable-mailbox invariants of Sentry Junior while using AWS-native storage: DynamoDB is the bounded
coordination plane, the artifact bucket is the immutable body/event/checkpoint/result plane, and S3
Files optionally exposes durable Codex app-server state and workspaces as a mounted filesystem.

Teams ingress now appends authenticated activities to this mailbox and sends an SQS wake-up. A
coordinator converts the durable turn into a bounded run, resumes a suspended MicroVM and Codex
thread when possible, and folds terminal output back into replayable context. GitHub, GitLab, Slack,
and the control API retain their one-shot v1 run behavior.

## Conversation identity and concurrency

The provider's existing thread is the user-facing conversation boundary. In Microsoft Teams, a new
top-level post starts a new Rat Things conversation and replies in that thread add turns to it. No
session command or special `new:` syntax is required.

Different provider threads use different DynamoDB partitions and S3 Files directories, so they may
run concurrently. Turns within one thread are serialized. A fenced DynamoDB lease ensures that only
one MicroVM at a time owns the conversation and opens its Codex SQLite state.

## Invariants

- The mailbox, not SQS, is the source of truth. Queue messages only wake a coordinator.
- Each conversation has at most one renewable worker lease and one active turn.
- The lease fences filesystem ownership: only one MicroVM may mount and open a conversation's Codex
  SQLite state at a time. Different conversations remain independently concurrent.
- Every mutating turn operation is fenced by the current lease token.
- `interrupt` messages sort ahead of `defer` messages without losing arrival order within a class.
- Checkpointing moves a turn to `awaiting_resume` and releases its lease. Another worker can acquire
  a new lease and resume the same turn at the next slice.
- DynamoDB stores only bounded records and previews. Full message bodies, event payloads,
  checkpoints, and results live in S3 behind checksummed references.
- Provider source, destination, actor, owner, and credential-subject contexts remain distinct.
- A run is attached to its turn before its dispatcher wake-up. A repeated conversation wake repairs
  the attach/enqueue crash window without creating a second semantic run.
- A terminal conversation VM is suspended before the turn is finalized, so failed suspension is
  retryable while the turn remains active.

## AWS mapping

| Conversation concern | AWS representation |
| --- | --- |
| Mailbox and conversation state | One DynamoDB partition per hashed conversation ID |
| Message priority | `conversation-work-index`, ordered by delivery class, time, and message hash |
| Worker ownership | Lease token and expiry on the conversation metadata item |
| Active turn and resume slice | Durable turn item in the same partition |
| Coordinator wake-up | Encrypted SQS queue plus Lambda event-source mapping |
| Execution continuation | Expiring MicroVM ID/state plus durable Codex thread ID on conversation metadata |
| Native Codex/workspace state | S3 Files access point rooted at a SHA-256 conversation directory |
| History and progress index | Append-only event items with bounded previews |
| Message/event/checkpoint/result bodies | Content-addressed objects in the encrypted artifact bucket |
| Retention | DynamoDB TTL plus the artifact bucket lifecycle policy |

The conversation table is separate from the run table. The run table's stream drives terminal
delivery, so mixing mailbox events into it would couple conversation coordination to result egress.

## Item and object layout

The physical DynamoDB key does not expose a provider conversation ID:

```text
pk = CONVERSATION#sha256(conversationId)

META
MAILBOX#sha256(messageId)
TURN#sha256(turnId)
EVENT#occurredAt#sha256(eventId)
```

Pending message items project these attributes into `conversation-work-index`:

```text
workPartition = CONVERSATION#sha256(conversationId)
workOrder     = 0|1#createdAt#sha256(messageId)
```

`0` means `interrupt`; `1` means `defer`. Consuming a message removes both index attributes in the
same transaction that decrements `pendingCount` and appends the consumption event.

S3 objects use owner- and conversation-hashed prefixes:

```text
owners/<owner-hash>/conversations/<conversation-hash>/messages/<message-hash>-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/events/<event-hash>-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/turns/<turn-hash>/slice-0000-<content-hash>.json
runtime/conversations/<conversation-hash>/codex-home/...
runtime/conversations/<conversation-hash>/workspace/...
```

The hash in each object name makes identical retries converge on the same object. A conflicting
reuse of a message ID is rejected by DynamoDB even when the provider retries concurrently.

## Turn lifecycle

```text
authenticated activity -> durable append -> SQS wake -> acquire lease
                                                    |
                                                    v
                                      attach run -> dispatch slice
                                                    |
                                      +-------------+-------------+
                                      |                           |
                                      v                           v
                               complete/fail             checkpoint/resume
                                      |
                                      v
                         suspend VM + save replay context
```

The transaction boundaries cover coordination records, not S3. Bodies are written to S3 first,
then their references are committed in DynamoDB. A failed DynamoDB transaction can therefore leave
an unreachable content-addressed object, which the bucket lifecycle policy eventually removes. A
DynamoDB record never points at an object that the service has not finished writing.

## Validation

`npm run test:e2e:localstack` provisions the real table, bucket, and queues and validates:

- idempotent append and conflicting message-ID rejection;
- interrupt-before-defer ordering through the DynamoDB GSI;
- lease acquisition and stale-token rejection;
- turn start, progress, message consumption, and event history;
- S3-backed checkpointing, lease release, reacquisition, and slice resume; and
- signed Teams ingress through mailbox, coordinator, run, completion, and threaded egress;
- terminal completion with all pending work consumed; and
- a second Teams activity selecting the prior MicroVM/Codex session and replaying prior context.

LocalStack validates the AWS control protocol and session-selection behavior but cannot implement
the Lambda MicroVM or S3 Files APIs. The disposable live-AWS suite validates same-VM suspend/resume,
session-expiry replacement, crash-window recovery, and a real Codex app-server turn that writes a
file with a tool call. It then terminates that VM, observes the file in the backing S3 bucket, mounts
the state in a replacement VM, resumes the exact Codex thread ID, and reads the exact bytes without
recreating them. It does not yet measure sustained concurrency/cost or validate Microsoft identity
and delivery into a real Teams tenant.

## Remaining Junior-parity gaps

The current interrupt policy is safe-boundary steering: a queued `interrupt` is selected before
deferred work for the next slice. It does not yet interrupt a running Codex command or stream live
progress. Recovery has leases, idempotent wake-ups, and durable replay, but still needs an active
session heartbeat/reconciler, explicit compaction summaries, and a user-visible handoff contract.
