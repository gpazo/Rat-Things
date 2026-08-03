# Architecture

## Scope

Indubitably Agent Runtime is an asynchronous job subsystem. It accepts a bounded, versioned run
request; assigns trusted ownership and provenance; schedules one isolated worker; persists the
result; and optionally posts that result to a channel. It is not a general workflow engine, source
control installation manager, or chat identity service.

The code is divided by responsibility:

| Area | Responsibility |
| --- | --- |
| `src/domain` | Stable request/result types, validation, and the run state machine; no AWS imports |
| `src/core` | Submission, idempotency, ownership, cancellation, and orchestration through ports |
| `src/adapters` | DynamoDB, S3, SQS, EventBridge, ECS, Lambda MicroVMs, SSM, and Secrets Manager |
| `src/channels` | Provider signature verification and webhook-to-run normalization |
| `src/lambdas` | Thin API Gateway, queue, stream, and EventBridge handlers |
| `src/runner` | The untrusted repository/model execution boundary shared by both backends |
| `infra/modules/agent-runner` | Reusable AWS infrastructure module |

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
dispatcher to attach the ECS task ARN or MicroVM ID to the durable record. This makes cancellation
targetable before untrusted work begins and fails closed if launch succeeded but attachment cannot
be repaired.

### 3. Isolated execution

Trusted worker orchestration creates an isolated per-run workspace and clones an allowlisted,
credential-free HTTPS repository when requested. It resolves the clone credential only for the Git
subprocess and optionally resolves a scoped Bedrock API key. It then hands the workspace to UID 10001
and launches a driver without a shell or the root process's AWS credential-chain environment. The
Codex driver uses
[`codex exec`](https://developers.openai.com/codex/noninteractive) in ephemeral JSON mode. The
Claude Code and mock drivers implement the same internal interface.

The child receives a small environment allowlist and, when configured, only
`AWS_BEARER_TOKEN_BEDROCK` for model access. `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=true` is an explicit
local/exception escape hatch and must remain false in production. This process separation materially
reduces exposure, but it does not replace the outer ECS/MicroVM, IAM, and egress boundaries.

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

## ECS and Lambda MicroVMs are distinct backends

Both backends run the same agent-worker contract, but they are not two labels for the same ECS
container:

| Property | ECS Fargate | AWS Lambda MicroVMs |
| --- | --- | --- |
| Provisioned unit | ARM64 ECS task definition and cluster | Lambda MicroVM image plus egress network connector |
| Per-run call | ECS `RunTask` | Lambda MicroVMs `RunMicrovm` |
| Runtime unit | One Fargate task per run | One Firecracker-backed MicroVM environment per run |
| Input bootstrap | Environment overrides containing run/storage IDs | Bounded `runHookPayload` containing run/storage IDs |
| Network | Task ENI in configured subnets/security groups | Explicit Lambda MicroVM network connector |
| Cancellation | ECS `StopTask` | `TerminateMicrovm` |
| Default/maturity | Baseline backend | Opt-in preview path; requires separate provisioning |

There is no always-on agent service and neither backend exposes user-facing or workload ingress. ECS
uses a container image directly. The MicroVM image listens on port 8080 inside the managed
environment for the service-required lifecycle hooks; that listener is not a prompt or agent API.
The MicroVM service builds a managed image from an S3 bundle containing a Dockerfile and artifacts,
captures a snapshot, and invokes those lifecycle hooks inside the VM. Its image, connector,
execution role, logging, duration, and hook semantics follow the
[Lambda MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html),
[networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html), and
[`RunMicrovm` API](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
documentation.

The MicroVM image must treat each `/run` hook as fresh work. Never snapshot secrets, run IDs, open
network sessions, or repository contents. Build-time and run-time connectors are different security
contexts; a running VM's connector cannot be changed. The service may preserve suspended state for
up to eight hours, so cleanup and per-run initialization remain mandatory. See the AWS
[snapshot guidance](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html).

AWS announced Lambda MicroVMs on June 22, 2026 with an initial limited Region set. Confirm the
current [availability announcement](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/)
before selecting a deployment Region. The Terraform and provisioner keep MicroVM creation disabled
unless explicitly requested; ordinary validation and ECS deployment do not create a MicroVM image.

## Data and control boundaries

### DynamoDB

The run table contains state, owner, timestamps, hashes, artifact references, bounded previews, and
delivery-fence items. It is not a prompt, transcript, token, or repository-content store. Runs
default to a 30-day TTL; deletion occurs asynchronously after expiry.

### S3

S3 is the durable body/artifact plane. Prompts, full results, event streams, and patches are stored
under owner-hashed run prefixes with checksums. Bucket encryption, public-access blocking, and
lifecycle policy are deployment responsibilities. An S3 reference is sensitive metadata and the
control API should remain authenticated.

### SQS and EventBridge

SQS wakes the dispatcher; it is not the canonical request store. A scheduled reconciler re-nudges
stale queued runs and stale dispatching/running records that have no attached execution handle, and
finalizes stale cancellations that never launched. Backend start uses the run ID as the ECS/MicroVM
client token, so recovering a dispatcher crash after launch does not intentionally create a second
execution. DynamoDB Streams are the durable source of state changes, and EventBridge carries their
bounded notifications; neither bus is the full result store. Stream-to-EventBridge retry is finite,
so exhausted invocations are retained in an encrypted SQS failure queue and alarmed for operator
replay. EventBridge-to-notifier retry is also finite and has its own encrypted, alarmed dead-letter
queue. Redelivery is expected, which is why state transitions and delivery fences are conditional.

### Secrets Manager and SSM

Secrets Manager stores webhook authenticators, repository/provider credentials, the scoped Bedrock
API key, and outbound channel URLs/tokens. SSM parameters hold non-secret provisioned MicroVM image
and connector ARNs. Workers receive only ARNs or resource coordinates. Trusted orchestration resolves
clone/model material before launching the unprivileged agent child; notification credentials remain
in the notifier.

## Identity model

Keep these namespaces independent:

| Identity | Examples | Decides | Must not decide |
| --- | --- | --- | --- |
| Source/owner | API JWT `sub`, GitHub installation/org, GitLab project, Teams tenant+sender | Run visibility, idempotency namespace, provenance | Which AWS/provider credential to use |
| Destination | `source`, Teams route name, Slack channel | Where a terminal result is attempted | Run ownership or credential contents |
| Credential | ECS task role, MicroVM execution role, a Secrets Manager ARN | What an adapter may access or call | Owner, source, or arbitrary destination |

The control endpoint overwrites any client-provided `source` with an API source and API Gateway
request ID. Webhook sources are created only after signature validation. Routes are opaque delivery
configuration keys, never secret values.

## Deliberate current limits

- No streaming result API, per-event API, approval endpoint, interactive agent session, or resume
  contract.
- The reconciler repairs missing wake-ups and unattached launch handles, but there is no active-run
  lease/heartbeat, backend-state repair for an attached execution, or automatic retry of a failed
  agent run. A new semantic run requires a new submission.
- Cancellation is cooperative at the worker and forceful at the backend; it is not guaranteed to
  retract an external side effect already made by an agent or notifier.
- The GitHub/GitLab webhook prompts include untrusted issue content. Comment runs require the
  configured trigger (`@indubitably` by default), but trigger text is not authorization. The outer
  task/VM, child identity/environment, network, and sandbox boundaries must assume prompt injection
  succeeds.
- GitHub/GitLab comment runs require a non-empty trigger. Provider result replies carry a hidden
  runtime marker, and normalization ignores marked replies plus GitHub `Bot`/GitLab bot authors to
  prevent ordinary self-trigger loops. These are loop/noise controls, not author authorization or a
  substitute for repository, budget, and rate policy.
- Teams currently uses outgoing-webhook ingress and Workflow-URL egress. The production Teams bot
  gateway described in [channels](channels.md) is roadmap work.
