# How to keep Codex running after you close your laptop

Run the agent on remote compute and retain its inputs and results outside your
laptop. Rat Things runs the API, harness, storage and execution in your AWS account.
A Session identifies the work; Turns record each execution and Items retain its
messages and tool activity.

## Choose where work runs

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
file with a managed or self-hosted environment using `--file request.json`.
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

Native checkpoints and saved workspace bytes support recovery after execution
loss. They do not guarantee that background processes, sockets or unacknowledged
external writes survive replacement. See [Session durability](../docs/conversations.md#how-durability-works)
and the [durable-state guide](durable-ai-agent-state.md).

## Try the narrow path

The [AWS quickstart](../docs/quickstart.md) creates a disposable deployment, runs two
root Turns in one Session, and provides teardown. Use an account and credentials
intended for that work.

## Sources

- [Rat Things Sessions](../docs/conversations.md)
- [Agents API](../docs/agents-api.md)
- [Capability envelope](../docs/capability-envelope.md)
