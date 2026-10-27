# How to keep Codex or Pi Durable running after you close your laptop

Run the agent on remote compute and retain its inputs and results outside your
laptop. Rat Things runs the API, harness, storage and execution in your AWS account.
A Session identifies the work; Turns record each execution and Items retain its
messages and tool activity.

## Choose where work runs

Rat Things supports Codex and Pi Durable in durable Sessions. Codex is the default;
Pi uses the deployment's approved Bedrock models. See
[runtime setup and limits](../docs/agent-runtimes.md).

A terminal multiplexer can survive closing a terminal on a machine that stays
awake. A remote worker lets work continue when your laptop sleeps. Durable storage
also preserves saved history and files if the worker is lost, but it cannot recreate
an arbitrary running process.

Rat Things supports isolated Lambda MicroVM execution and an opt-in dedicated EC2
Session worker. A connected EC2 worker can retain processes between Turns without
being subject to the MicroVM's eight-hour maximum lifetime. Retained state and a
live environment are separate properties: inspect Session and environment status
before assuming work can continue.

## Submit a Session

Configure `RAT_THINGS_AGENTS_API_URL`, `AWS_REGION` and your AWS credentials for the
deployment. Replace the model placeholder with a model admitted by that deployment:

```bash
npm run rat-things -- sessions create \
  --model YOUR_ADMITTED_MODEL \
  --input "Draft a release-readiness checklist with rollback steps."
```

This example uses `environment: {"type":"none"}` and needs no repository checkout.
To use Pi Durable, add `--runtime pi` and select a model returned by
`npm run rat-things -- agents models --runtime pi`.
Save the returned Session ID before disconnecting. Later, replace `sess_example`
with that ID to inspect and continue the work:

```bash
npm run rat-things -- sessions get sess_example
npm run rat-things -- sessions turns sess_example
npm run rat-things -- sessions items sess_example
npm run rat-things -- sessions send sess_example \
  --idempotency-key release-review-2 \
  --input "Refine the checklist into a concise go/no-go review."
```

A repeated input with the same idempotency key and body reuses its accepted
receipt. To work with commands and files, supply a standard Session creation JSON
file with a managed environment using `--file request.json`. Codex also supports
self-hosted environments; Pi does not.
See [Agents API](../docs/agents-api.md) for those request shapes.

## Retain results and control authority

Encrypted S3 retains full content and native checkpoints; DynamoDB holds resource
revisions and coordination fences. Managed output files under `/workspace/outputs`
are saved as immutable Session artifacts when Turns finish. Download them before
deleting the Session. Saved Items and artifacts survive environment expiration.

The Agent configuration, declared tools, environment policy and credential grants
bound the work. A denied operation cannot open a human-approval path that widens
that authority. Notification connections do not automatically grant tools to the
agent. Read [the capability envelope](../docs/capability-envelope.md).

## Close work deliberately

Use `sessions cancel sess_example` to stop active work while retaining the Session.
Use `sessions delete sess_example` when it is no longer needed; deletion removes
it from the public API and closes its private harness. A connected worker can incur
compute costs while waiting for another Turn.

## Current boundaries

Codex native checkpoints support conversation recovery. Preserving its managed workspace
across a clean handoff requires S3 Files and `session_checkpoints_enabled`; ordinary
replacement resets sandbox files. Neither path restores background processes or
sockets. An unacknowledged external write requires separate reconciliation. See
[Session durability](../docs/conversations.md#how-durability-works)
and the [durable-state guide](durable-ai-agent-state.md).

Pi Durable restores committed tasks, pending tool calls, and child relationships.
Managed Pi workspaces require S3 Files and checkpoints, and retain flushed files
after verified worker termination. A saved child agent can resume its task even
though its old operating-system process no longer exists.

## Try the narrow path

The [AWS quickstart](../docs/quickstart.md) creates a disposable deployment, runs two
root Turns in one Session, and provides teardown. Use an account and credentials
intended for that work.

## Frequently asked questions

### Will work keep running when my laptop sleeps?

An AWS Session can continue while your laptop is disconnected because execution
runs on a remote worker. A local Session still depends on your computer staying
awake. Saved history remains distinct from a currently running process.

### Does a worker failure erase the conversation?

Saved Session history and artifacts live outside the worker. Continuing execution
depends on the runtime's recovery rules and available checkpoints; live processes
and sockets are not recreated from the transcript.

## Sources

- [Rat Things Sessions](../docs/conversations.md)
- [Agents API](../docs/agents-api.md)
- [Capability envelope](../docs/capability-envelope.md)
