# Architecture

## Scope

Rat Things is an asynchronous agent subsystem. Its deployed webhook flow accepts a bounded,
versioned run request; assigns trusted ownership and provenance; schedules one isolated worker;
persists the result; and optionally posts that result to a channel. It also contains an AWS-backed
durable conversation foundation for prioritized messages, worker leases, progress, history, and
checkpointed turn slices. Signed Teams mentions enter that mailbox and wake the bounded slice
coordinator. Rat Things is not a general workflow engine, source control installation manager, or
chat identity service.

## System promise

Rat Things separates the lifetime of an agent from the lifetime of its compute:

- a channel thread or API conversation is the durable unit of work;
- DynamoDB owns coordination, fencing, ordering, and bounded history indexes;
- immutable S3 objects own messages, events, checkpoints, results, and normalized replay;
- S3 Files owns the mutable Codex home and workspace expected by app-server;
- a Lambda MicroVM owns exactly one fenced conversation while it runs; and
- suspension is an optimization, not a durability boundary—a replacement VM can restore the same
  Codex thread and workspace after the original is terminated.

This makes the execution layer serverless without reducing an agent to a stateless model call.

The code is divided by responsibility:

| Area | Responsibility |
| --- | --- |
| `src/domain` | Stable request/result types, validation, and the run state machine; no AWS imports |
| `src/core` | Submission, idempotency, ownership, cancellation, and orchestration through ports |
| `src/conversation` | Durable mailbox, lease, progress, history, and resumable-turn coordination |
| `src/identity` | Explicit actor, owner, source, and credential-subject context |
| `src/credentials` | Host-owned secret resolution and bounded credential extraction |
| `src/ingress` | Provider-neutral webhook lifecycle plus GitHub/GitLab/Teams/Slack adapters |
| `src/delivery` | Destination resolution, delivery lifecycle, and provider egress adapters |
| `src/execution` | Provider-neutral dispatch and execution-backend registry |
| `src/plugins` | Validated manifests binding provider ingress and delivery capabilities |
| `src/adapters` | DynamoDB, S3, SQS, EventBridge, Lambda MicroVMs, SSM, and Secrets Manager |
| `src/channels` | Pure provider payload normalization and signature helpers |
| `src/app` | Composition root that supplies host-owned ports to trusted built-in plugins |
| `src/lambdas` | Thin API Gateway, SQS, stream, and EventBridge transport adapters |
| `src/runner` | The untrusted repository/model execution boundary shared by both backends |
| `infra/modules/agent-runner` | Reusable AWS infrastructure module |

`npm run architecture:check` rejects imports that reverse these dependencies. In particular,
provider plugins cannot import Lambda handlers, AWS adapters, the composition root, or the worker.

## Junior-inspired abstraction model

Junior was used as an architectural reference, not as a runtime dependency. The corresponding
concepts in this subsystem are:

| Junior concept | Agent Runtime equivalent | Deliberate difference |
| --- | --- | --- |
| App composition root | `src/app/composition.ts` | Composes AWS Lambda/job capabilities rather than a Vercel chat app |
| Ingress adapters | `src/ingress/providers` | GitHub, GitLab, Teams, and optional Slack enter one run contract |
| Runtime/services | `src/core`, `src/conversation`, and `src/execution` | Bounded MicroVM runs plus a separate AWS-backed resumable conversation model |
| Conversation mailbox | DynamoDB conversation partition plus S3 bodies/checkpoints | Durable AWS state, SQS coordination, bounded run slices, replay, and Teams completion |
| Plugin host/API | `src/plugins` | Trusted built-ins only; no arbitrary package discovery or user plugin execution |
| Credential broker | `src/credentials` | Secrets Manager references stay host-owned; no OAuth flow yet |
| Sandbox/runtime | Lambda MicroVM plus `src/runner` | AWS isolation replaces Vercel Sandbox |
| Provider egress | `src/delivery/providers` | EventBridge terminal delivery with a DynamoDB fence |

The key invariant is the same: provider modules depend on small host-supplied contracts and do not
own orchestration, durable state, execution, or credentials. See [the plugin model](plugins.md).

## C4 diagrams

- **C1 — system context:** [PNG](c4-system-context.png), [SVG](c4-system-context.svg),
  [Mermaid source](c4-system-context.mmd)
- **C2 — agent runtime:** [PNG](c4-runtime-containers.png), [editable SVG](c4-runtime-containers.svg)
- **C2 — live AWS test harness:** [PNG](c4-live-aws-test-harness-containers.png),
  [SVG](c4-live-aws-test-harness-containers.svg),
  [Mermaid source](c4-live-aws-test-harness-containers.mmd)
- **C2 — LocalStack test harness:** [PNG](c4-localstack-test-harness-containers.png),
  [SVG](c4-localstack-test-harness-containers.svg),
  [Mermaid source](c4-localstack-test-harness-containers.mmd)

## Lifecycle

### 1. Ingress and acceptance

`POST /v1/runs` uses the API Gateway-authorized principal. Public webhook routes first authenticate
the exact raw request with the provider-specific signature or secret, then normalize the provider
payload into the same v1 request.

The submission service validates the normalized request, calculates its canonical request hash, and
stores the full body in S3. A small run record is conditionally inserted in DynamoDB before an SQS
wake-up message is sent. With an idempotency key, the run ID is deterministic within the owner
namespace: replaying the same body returns the existing run and re-nudges it when still queued;
reusing the key for a different body returns a conflict. If queue send fails, the durable record stays
`queued`; the same idempotent client retry or the one-minute reconciler repairs the wake-up.

### 2. Dispatch

The SQS dispatcher loads the canonical request from S3 and conditionally advances the run:

```text
queued -> dispatching -> running -> succeeded
   |           |           |
   +-----------+-----------+----> failed
   |           |
   |           +----> cancelling -> cancelled
   +-----------------------------> cancelled
```

Conditional DynamoDB writes make stale or duplicate deliveries harmless at the state-transition
boundary. This does not make arbitrary external side effects exactly once.

The dispatcher chooses `execution.backend`, or the deployment default, and starts one execution. It
passes identifiers and storage coordinates, not the prompt or a provider token. The worker loads and
revalidates the stored request. Before it starts the agent, the worker waits up to 60 seconds for the
dispatcher to attach the MicroVM ID to the durable record. This makes cancellation
targetable before untrusted work begins and fails closed if launch succeeded but attachment cannot
be repaired.

### 3. Isolated execution

Trusted worker orchestration creates an isolated per-run workspace and clones an allowlisted,
credential-free HTTPS repository when requested. It resolves the clone credential only for the Git
subprocess and mints a short-term Bedrock bearer token from the execution role (or resolves an
explicitly configured Bedrock key). It then hands the workspace to UID 10001
and launches a driver without a shell or the root process's AWS credential-chain environment. The
Codex driver uses
[`codex exec`](https://developers.openai.com/codex/noninteractive) in ephemeral JSON mode. The
The deterministic mock driver implements the same internal interface for tests.

The child receives a small environment allowlist and, when configured, only
`AWS_BEARER_TOKEN_BEDROCK` for model access. `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=true` is an explicit
local/exception escape hatch and must remain false in production. This process separation materially
reduces exposure, but it does not replace the outer MicroVM, IAM, and egress boundaries.

The worker writes:

- `result.md`, the complete final response;
- `events.jsonl`, the driver's event stream;
- `workspace.patch`, only when the checkout changed; and
- a bounded result preview and execution metadata in DynamoDB.

It then commits terminal state in DynamoDB. A DynamoDB Streams Lambda turns each state change into an
`Agent Run State` event on EventBridge. This narrows the worker-state-commit/event-publish crash
window because the stream is independent of the worker, but it is not a permanent outbox: the
current event-source mapping accepts records for up to 24 hours and retries a failed batch ten times.
Exhausted invocations go to an encrypted SQS failure destination with an alarm, but replay remains an
operator action. Workspaces are deleted at worker exit.

### 4. Delivery

The notifier reacts only to terminal EventBridge states. It resolves `source` destinations using the
trusted stored source metadata, then posts through the appropriate provider adapter. A per-run,
per-destination DynamoDB fence suppresses ordinary duplicate delivery. A confirmed retryable
non-delivery releases the fence for EventBridge retry; an ambiguous outcome is retained as
`outcome_unknown` to avoid a blind duplicate post. A `sending` claim has a 120-second lease: event
redelivery while it is live fails for another EventBridge retry, and an expired lease is
conditionally reclaimed. This closes a permanent-stuck window, but a crash after the provider
accepted a post and before `delivered` was recorded can still cause a duplicate after lease reclaim.
Operators must reconcile `outcome_unknown` states against the provider before an audited retry.

The EventBridge notifier target retries failed invocations up to 185 times over 24 hours. Exhausted
events go to a separate encrypted SQS dead-letter queue, with alarms both for visible DLQ messages and
failure to write the DLQ. Redrive is an operator action.

This is an explicit best-effort delivery policy, not a claim of exactly-once messaging.

## Lambda MicroVM execution

Lambda MicroVM is the only remote execution backend:

| Property | Behavior |
| --- | --- |
| Provisioned unit | Lambda MicroVM image using a pinned managed base-image version |
| Isolation boundary | One Firecracker-backed guest kernel and MicroVM per active run/session |
| First slice | `RunMicrovm` with a bounded `runHookPayload` containing run/storage IDs |
| Later conversation slices | `ResumeMicrovm`, short-lived endpoint token, then authenticated port-8080 request |
| Runtime unit | One disposable VM per one-shot run or one suspended/resumable VM per bounded conversation session |
| Network | AWS-managed public egress for one-shot runs; S3 Files conversations use a dedicated VPC connector and NAT egress |
| Durable filesystem | Per-conversation S3 Files directory containing Codex home/SQLite state and workspace bytes |
| Idle lifecycle | Conversation VMs suspend; one-shot VMs terminate; expiry creates a fresh VM with S3 Files plus normalized replay |
| Cancellation/cleanup | `SuspendMicrovm` or `TerminateMicrovm` by exact MicroVM ID |

### Why this execution boundary

Lambda MicroVMs combine capabilities that previously required choosing between different operating
models: dedicated VM-level isolation, snapshot-based launch/resume, retained session state, and
Lambda-managed lifecycle. AWS positions the primitive specifically for multi-tenant systems that
execute user- or AI-generated code. The same tradeoff is the central theme in this [r/aws community
discussion](https://www.reddit.com/r/aws/comments/1ueul5o/hardest_problems_lambda_microvms_can_solve_now/).

Those properties map directly to agent execution:

- repository bytes, prompts, generated code, and tool commands are treated as untrusted;
- a dedicated guest kernel reduces cross-session blast radius compared with a shared process or
  application-container boundary;
- a pre-initialized image avoids rebuilding the tool environment for every turn;
- suspend/resume preserves a responsive interactive session without keeping it continuously active;
- termination by exact MicroVM ID provides a forceful backend boundary when guest work does not
  cooperate; and
- Lambda functions, SQS, DynamoDB, and EventBridge remain the event-driven control plane rather
  than an always-on scheduler fleet.

These properties do not make arbitrary agent work safe by themselves. IAM scope, egress policy,
credential handling, resource budgets, output projection, and destination authorization remain
separate controls. See the [AWS Lambda MicroVM launch
post](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
and [security model](security.md).

### Three layers of continuity

Rat Things uses three deliberately different state layers:

1. A suspended MicroVM preserves memory, disk, and running processes for fast continuation within
   AWS's bounded session lifetime.
2. S3 Files preserves Codex app-server state and workspace bytes across MicroVM replacement.
3. The normalized DynamoDB/S3 archive preserves messages, events, checkpoints, summaries, and
   results independently of Codex's native storage format.

The first layer optimizes latency. The latter two provide durability beyond one VM's lifetime.

There is no always-on agent service. The image listens on port 8080 for lifecycle hooks and a
service-authenticated continuation endpoint exposed only by the AWS-managed ingress connector. The
coordinator mints a short-lived MicroVM auth token for that exact endpoint and port; callers do not
receive it. The service builds a managed image from an S3 bundle containing a
Dockerfile and artifacts, captures a snapshot, and invokes those lifecycle hooks inside the VM. Its
image, managed connector, execution role, logging, duration, and hook semantics follow the
[Lambda MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html),
[networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html), and
[`RunMicrovm` API](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
documentation.

The image treats each `/run` hook as fresh one-shot work and each authenticated continuation as a
serialized slice of the same conversation. Never capture secrets or workload state in the reusable
image snapshot. A running VM's connector cannot be changed. A suspended session may preserve disk
and memory for up to eight hours. With S3 Files enabled, a replacement VM mounts the conversation's
Codex home and workspace; DynamoDB fencing prevents simultaneous SQLite access. Normalized artifact
replay remains authoritative if native app-server resume is incompatible. See the AWS
[snapshot guidance](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html).

AWS launched Lambda MicroVMs with an initial limited Region set. Confirm current availability before
selecting a deployment Region. Terraform requires MicroVM provisioning because there is no fallback
execution backend.

## Data and control boundaries

### DynamoDB

The run table contains state, owner, timestamps, hashes, artifact references, bounded previews, and
delivery-fence items. It is not a prompt, transcript, token, or repository-content store. Runs
default to a 30-day TTL; deletion occurs asynchronously after expiry.

The separate conversation table contains one hashed partition per conversation with metadata,
pending message projections, turn state, renewable leases, and append-only history records. A GSI
orders `interrupt` work ahead of `defer` work. DynamoDB transactions fence mutations by lease token
and keep message consumption, pending counts, and history consistent. See
[durable conversations](conversations.md).

### S3

S3 is the durable body/artifact plane. Prompts, full results, event streams, patches, conversation
message bodies, history payloads, turn checkpoints, and user-visible files are stored under
owner-hashed prefixes with checksums. Each completed conversation turn commits a bounded file
catalog. The runner restores those files into `.rat-things/artifacts/` before execution, so a new
MicroVM does not depend on residual local bytes. Bucket encryption, public-access blocking, and
lifecycle policy are deployment responsibilities. An S3 reference is sensitive metadata and the
control API should remain authenticated.

An authenticated owner mints an unguessable, time-bounded file-share URL through the control API.
The public share route reads only its hashed encrypted record and redirects to a freshly signed
one-minute S3 URL. This makes the default 24-hour share lifetime independent of rotating Lambda
role credentials while keeping the bucket private and the file bytes off the control Lambda.

When `enable_s3_files=true`, a separate versioned bucket backs an S3 Files filesystem. Its access
point exposes only `/conversations` to the MicroVM execution role. Each hashed conversation owns a
`codex-home` directory (including Codex's SQLite state) and a `workspace` directory. This path is
mutable filesystem state, distinct from the immutable artifact/checkpoint records above.

### SQS and EventBridge

SQS wakes the dispatcher; it is not the canonical request store. A scheduled reconciler re-nudges
stale queued runs and stale dispatching/running records that have no attached execution handle, and
finalizes stale cancellations that never launched. Backend start uses the run ID as the MicroVM
client token, so recovering a dispatcher crash after launch does not intentionally create a second
execution. DynamoDB Streams are the durable source of state changes, and EventBridge carries their
bounded notifications; neither bus is the full result store. Stream-to-EventBridge retry is finite,
so exhausted invocations are retained in an encrypted SQS failure queue and alarmed for operator
replay. EventBridge-to-notifier retry is also finite and has its own encrypted, alarmed dead-letter
queue. Redelivery is expected, which is why state transitions and delivery fences are conditional.
The separate conversation queue follows the same rule: the mailbox is canonical. Its coordinator
attaches a deterministic run before waking the run queue, and a duplicate wake repairs a missed
enqueue without creating a second semantic slice.

### Secrets Manager and SSM

Secrets Manager stores webhook authenticators, repository/provider credentials, the scoped Bedrock
API key, and outbound channel URLs/tokens. SSM parameters hold the non-secret provisioned MicroVM
image ARN/version. Workers receive only ARNs or resource coordinates. Trusted orchestration resolves
clone/model material before launching the unprivileged agent child; notification credentials remain
in the notifier.

## Identity model

Keep these namespaces independent:

| Identity | Examples | Decides | Must not decide |
| --- | --- | --- | --- |
| Actor | API principal, provider sender, or verified system event | Attribution retained in run provenance | Run ownership or provider credentials |
| Owner | API JWT `sub`, GitHub installation/org, GitLab project, Teams tenant+sender | Run visibility and idempotency namespace | Destination or credential authority |
| Source | API, GitHub delivery, GitLab event, Teams activity, Slack event | Trusted trigger provenance and source reply resolution | Ownership by itself |
| Destination | `source`, Teams route name, Slack channel | Where a terminal result is attempted | Run ownership or credential contents |
| Credential subject | API actor or deployment runtime | Which host-owned authority may be considered | Destination, ownership, or secret value |
| Credential | MicroVM execution role, a Secrets Manager ARN | What an adapter may access or call | Actor, owner, source, or arbitrary destination |

The control endpoint overwrites any client-provided `source` with an API source; the per-attempt API
Gateway request ID remains queue trace metadata so it cannot change the idempotent request hash.
Webhook sources and provenance are created only after signature validation. Routes are opaque
delivery configuration keys, never secret values.

## Deliberate current limits

- No streaming result API, per-event API, approval endpoint, or mid-command steering. Teams invokes
  the durable conversation coordinator, but `interrupt` currently takes effect only at the next
  safe slice boundary.
- LocalStack validates persistent-session selection and durable replay, not the Lambda MicroVM
  suspend/resume APIs or endpoint auth. The disposable AWS suite covers that continuation path,
  including retained workspace bytes, real Codex thread resume, expiry fallback, and crash repair.
- The reconciler repairs missing wake-ups and unattached launch handles, but there is no active-run
  lease/heartbeat, backend-state repair for an attached execution, or automatic retry of a failed
  agent run. A new semantic run requires a new submission.
- Cancellation is cooperative at the worker and forceful at the backend; it is not guaranteed to
  retract an external side effect already made by an agent or notifier.
- The GitHub/GitLab webhook prompts include untrusted issue content. Comment runs require the
  configured trigger (`@rat-things` by default), but trigger text is not authorization. The outer
  task/VM, child identity/environment, network, and sandbox boundaries must assume prompt injection
  succeeds.
- GitHub/GitLab comment runs require a non-empty trigger. Provider result replies carry a hidden
  runtime marker, and normalization ignores marked replies plus GitHub `Bot`/GitLab bot authors to
  prevent ordinary self-trigger loops. These are loop/noise controls, not author authorization or a
  substitute for repository, budget, and rate policy.
- Teams currently uses outgoing-webhook ingress and Workflow-URL egress. The production Teams bot
  gateway described in [channels](channels.md) is roadmap work.
