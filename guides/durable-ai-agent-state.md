# Durable AI agent state

Durable agent work needs separate records for accepted input, observed execution,
saved results and external effects. Keeping a worker alive helps continuation;
storing a transcript alone does not make a lost worker recoverable.

Rat Things uses the Agents API's Session, Turn and Item primitives. Its API,
harness, compute and storage remain in the deployment's AWS account.

## Separate the state that must survive

| State | Purpose | Rat Things boundary |
| --- | --- | --- |
| Session configuration | Fixed model, tools and environment selection | Owner-scoped Session snapshot |
| Input receipt | Identify one accepted semantic input | Conditional write and idempotency key |
| Turn and Items | Retain observed work and outcomes | Durable Session journal and saved public resources |
| Native checkpoint | Continue the harness's private context | Native state in Session storage |
| Workspace | Retain files changed by commands | Mounted Session storage and explicit output artifacts |
| Delivery outcome | Avoid repeating an external notification | Separate delivery fence with uncertain outcomes |

## Commit input before dispatch

The Session service validates input against current state, reserves the receipt
and writes durable outbox work before dispatch. Repeated delivery of that work
must reuse the accepted input rather than create a new Turn. An idempotency key
binds a retry to the same request body.

The outbox coordinates execution separately from provider delivery. A failed
notification does not rerun the model; a worker exiting does not produce a second
notification for an already saved terminal root Turn.

```text
client -> Session input receipt -> durable execution outbox
                    |                         |
                    v                         v
             saved Session state <--- fenced harness journal
                    |
                    v
            terminal root Turn -> independent delivery outbox
```

Private Run records identify the worker generation. They are implementation state,
not a second public conversation API. See [Session durability](../docs/conversations.md#how-durability-works).

## Fence execution and late observations

A worker must match its Run ID, execution ID and generation before updating state.
Health checks combine that identity with backend state; an unverified worker is
not assumed terminal. Recovery quarantines ambiguous execution until authority
can be established. Conditional writes prevent a replaced worker's late results
from taking ownership of the Session.

Control requests carry the intended public Turn ID. A delayed cancellation or
steering command must not target whichever Turn happens to be active later.
Durable EC2 commands are claimed before effects; ambiguous command acceptance is
not permission to replay them.

## Recover from the strongest available state

Prefer the saved native checkpoint and workspace. Public Item history is a fallback
that can retain messages and completed tool results. Historical commands, MCP
calls and child activity remain historical data; recovery must not execute them
again merely to rebuild context.

Neither fallback history nor copied files recreate live processes, sockets or
hidden child state. A connected managed environment retains its process state
between Turns; replacing a lost environment is a different operation. Saved
history remains available even when further execution is unavailable.

## Retain immutable output

Managed output files under `/workspace/outputs` are captured before terminal Turn
publication. Each artifact identifies its Turn and path and retains immutable
bytes. A later Turn can create another artifact for the same path. Expiration of
the environment does not remove saved artifacts; Session deletion does.

Self-hosted environment files remain under the operator's file/storage interface.
They are not automatically published through the managed Session Artifacts API.
See [durable files](../docs/durable-files.md).

## Reconcile external effects

A timed-out provider call can have succeeded remotely. Keep uncertain outcomes
separate from confirmed failures and inspect the provider's state or use its
idempotency facility before retrying. A database receipt cannot make an arbitrary
remote mutation exactly once.

Use stable input keys and retain Session and Turn IDs in the surrounding
application. Read saved state after a stream reconnect; a live event stream is a
notification channel, not the sole copy of completed work.

## Current boundaries

Recovery depends on available native checkpoints, storage, execution authority and
an environment that can continue work. Saved public history is not a guarantee of
process continuity. A lost acknowledgement for an external write requires separate
reconciliation.

## Sources

- [Session durability](../docs/conversations.md#how-durability-works)
- [Execution architecture](../docs/architecture.md)
- [Durable files](../docs/durable-files.md)

## Try the narrow path

Use the [quickstart](../docs/quickstart.md) with a disposable deployment, then retain
its Session ID and inspect saved Turns and Items through the standard API.
