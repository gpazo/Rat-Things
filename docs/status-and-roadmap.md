# Status and roadmap

## Current maturity

Rat Things is an **engineering preview**, not a production-ready service. The focused tests cover
domain behavior, webhook signatures and normalization, process/workspace safeguards, drivers,
executor payloads, the LocalStack data/event path, a disposable live-AWS mock-agent path, and a
two-turn Codex-on-Bedrock persistence run in a live Lambda MicroVM. A signed, headless Rat Things
CLI now exercises the same durable conversation path without a provider webhook. These tests do not
constitute a penetration test, quota/load exercise, broad real-agent evaluation, or
disaster-recovery proof.

| Capability | Status | Notes |
| --- | --- | --- |
| Run contract and state machine | Implemented/tested | Strict validation, conditional transitions, owner-scoped idempotency |
| Provider plugin boundary | Implemented/tested | Trusted manifests bind ingress/delivery; dependency checks prevent authority inversion |
| Control API | Implemented/live validated | Submit/list/get/cancel and owner-checked short-lived artifact URLs |
| Durable agent files | Implemented/live validated | `.rat-things/artifacts/` outbox, immutable S3 bytes, conversation catalog restoration, and CLI list/24-hour URL/download commands passed in a real Codex MicroVM |
| File/site/video publications | Implemented/live validated | Agent-declared publishing, content-derived reuse, manifest-last commit, isolated wildcard hosts, CloudFront OAC, signed redemption, and API/CLI commands passed recipient-open validation |
| Durable AWS orchestration | Locally/live validated | DynamoDB, S3, SQS, Streams, EventBridge, notifier delivery, failure queues |
| Conversation mailbox | End-to-end locally/live validated | Teams ingress, DynamoDB/S3 mailbox, interrupt/defer ordering, leases, SQS coordinator, durable replay, terminal completion, expiry fallback, and crash-window repair |
| Lambda MicroVM runner | One-shot/resume/replacement live validated | Same-ID suspend/resume plus S3 Files workspace restoration in a replacement VM passed in `us-west-2` |
| ECS replacement | Complete | Before removal, the same pinned checkout produced byte-identical output/events and equivalent execution metadata on the legacy task and MicroVM paths; the post-removal live suite then passed with no ECS/VPC fallback |
| Codex driver | Two-turn app-server live validated | One real app-server thread retained its ID and workspace across two different MicroVMs using short-term Bedrock auth; trusted local runs can reuse the device's ChatGPT subscription |
| Mock driver | Implemented/tested | Used for deterministic local and live infrastructure validation |
| GitHub/GitLab | Initial adapters | Signed ingress, loop guards, source-thread egress; credential and policy hardening remain |
| Teams | Durable chat path locally/live AWS validated | Signed mentions get an immediate acknowledgement, enter the mailbox, and complete through threaded gateway egress; Microsoft authentication and live tenant delivery remain |
| Slack | Optional initial adapter | App mentions and threaded posts; not the primary deployment target |
| Observability/recovery | Partial/live measured | Low-cardinality queue/processing metrics, structured logs, durable queues/events, reconciler, delivery leases, failure queues/alarms; broader chaos drills remain |
| Cost model | Live canary baseline measured | The 2026-08-16 two-turn site canary is about $0.380 at public list rates; non-model infrastructure fell to about $0.046, while sustained-load ceilings remain unmeasured |
| Multi-tenant hardening | Not complete | Requires safe response projection, destination authorization, budgets, rate limits, and security review |

## Validation completed on 2026-08-16

- A real Codex MicroVM received a fresh headless API turn, created a 12,244-byte animated site,
  published it automatically, suspended, resumed the exact same VM and Codex thread for a revision,
  and published the updated 14,624-byte site.
- An unauthenticated recipient followed the complete `/__share/<token>` URL through one redirect and
  received `200 text/html` with all 14,624 bytes. Authenticated output retrieval also succeeded after
  fixing S3's missing-key `AccessDenied` behavior without adding bucket-list authority.
- A second output retrieval reused the committed content-derived publication: its three S3 object
  timestamps stayed unchanged while the control plane could issue a fresh time-bounded grant.
- Cold message-to-runner time was 27.45 seconds and warm message-to-runner time was 1.99 seconds.
  Embedded metrics recorded the cold queue delays as 695 ms and 565 ms and warm delays as 133 ms
  and 124 ms.
- High-churn Codex temp/cache/plugin-cache and publication-staging directories stayed on VM-local
  bind mounts. The conversation's S3 Files backing set was 155 objects and 13.39 MB.
- The two-turn public-list estimate is about $0.380: $0.334 model inference and about $0.046 other
  infrastructure.
- The full local quality gate passed with 162 tests and 11 intentional skips, plus architecture,
  package, site, and Terraform validation.

## Validation completed on 2026-08-14

- A fresh disposable `us-west-2` stack passed all seven live workflows: the IAM control and
  conversation APIs, signed GitHub/GitLab/Teams ingress, same-MicroVM suspension and continuation,
  forced replacement after expiry, coordinator crash-window repair, repository checkout, and real
  Codex thread/workspace restoration across replacement MicroVMs.
- The built `rat-things` executable was launched as two independent headless processes. Both used
  the same human-readable thread name, reached the live AWS conversation API, reused one suspended
  MicroVM, and retained both turn markers. This deterministic CLI canary used the mock driver; the
  separate real-Codex workflow exercised the same API and durable execution path with Bedrock.
- The live run exposed and fixed a transient continuation race: the executor now retries bounded
  `502`/`503`/`504` responses while a suspended MicroVM proxy becomes ready.
- A real headless Codex turn published a 31,286-byte WebP through `.rat-things/artifacts/`; a separate
  CLI process minted a 24-hour URL, followed its redirect to the Rat Things artifact bucket, and
  downloaded the exact expected SHA-256. The conversation then remained available in a suspended
  MicroVM for continuation.
- The replacement live stack used `rat-things-*` resource names and reported `service=rat-things`;
  the 158-resource disposable legacy stack was destroyed after the branded link passed.
- S3 Files mounting was hardened for Lambda MicroVM process supervision, and ephemeral teardown now
  retries AWS's short pending-export window. The validation stack destroyed all 154 resources;
  only the expected KMS key pending deletion remained.
- The full local quality gate passed with 130 tests and 11 intentional skips, plus architecture,
  package, smoke, site, and Terraform validation.

## Validation completed on 2026-08-03–04

- TypeScript typecheck, unit/integration tests, architecture boundaries, Lambda/MicroVM packaging,
  and all Terraform formatting/validation gates.
- Disposable LocalStack end to end: signed GitHub/GitLab normalization and full signed Teams
  ingress-to-WireMock egress, including real LocalStack data/event services and durable fencing.
- LocalStack durable conversation lifecycle: idempotent mailbox append, interrupt-before-defer GSI
  ordering, lease fencing, progress/history, S3 checkpointing, worker reacquisition, slice resume,
  consumption, and completion. This test exposed and fixed a reserved-keyword bug in the DynamoDB
  completion transaction.
- LocalStack Teams conversation flow: signed ingress, durable append, SQS coordinator, bounded run,
  completion/replay checkpoint, threaded egress, duplicate suppression, and a second turn selecting
  the retained MicroVM and Codex thread IDs.
- Opt-in LocalStack Teams chat: a signed `@Rat Things` fixture executed through the device's
  ChatGPT-backed Codex session and produced a captured reply addressed to the exact inbound
  `conversationId` and activity ID; command networking remained disabled.
- Pre-cutover live parity: identical pinned GitHub repository input through both execution paths,
  with exact output/event bytes, hashes, exit status, usage fields, and patch presence compared.
- Post-cutover live AWS: IAM-authenticated API plus real signed GitHub, GitLab, and Teams requests;
  repository checkout; S3 artifacts; DynamoDB state; EventBridge terminal events; Adaptive Card egress
  capture; empty failure queues; and MicroVM self-termination.
- Real Codex on Bedrock: the pinned Codex binary returned the expected marker locally and from a
  live Lambda MicroVM using `openai.gpt-5.6-terra`, with non-mock events, usage, state, and artifacts.
- Real Codex with ChatGPT account auth: the repository's local runner selected the built-in OpenAI
  provider, reused this device's cached subscription login, and returned the expected marker without
  a Bedrock token or Platform API key.
- Fresh-deployment replay: a live test exposed a DynamoDB Streams startup gap caused by `LATEST`;
  changing the dedicated run-table consumer to `TRIM_HORIZON` made the complete control/webhook and
  repository-backed MicroVM suite pass on a newly created stack.
- Infrastructure replacement: the temporary stack removed the task/cluster/image repository and all
  customer networking resources, then passed the complete live suite again.
- Live persistent conversation: two signed Teams turns passed through the mailbox and coordinator;
  AWS reported the first MicroVM `SUSPENDED`, the second run used that exact MicroVM ID through the
  authenticated continuation endpoint, prior/new context reached output, the VM re-suspended, both
  threaded replies arrived, and all failure queues remained empty. This run exposed and fixed missing
  DynamoDB transaction item permissions and a duplicate-dispatch `RunMicrovm` creation race.
- Live retained execution state: Codex app-server used a shell tool to create/read a unique file;
  the first MicroVM was terminated, the file appeared independently in the backing S3 bucket, and a
  replacement MicroVM mounted it, resumed the exact same Codex thread ID, and read the same bytes
  without recreating the file.
- Live expiry and crash recovery: backdating a suspended session forced a replacement MicroVM with
  durable S3/DynamoDB replay and termination of the expired VM; an injected coordinator crash after
  launch was repaired onto the same semantic run with one schedule event and no failed messages.
- The live probes also exposed and fixed S3 Files prefix validation, a false-positive mount check,
  root/UID workspace ownership, base-image version drift during image updates, and loss of the Codex
  thread ID when a MicroVM lease expired.
- Cost Explorer, CloudTrail, local Terraform state, and AWS Price List data reconstructed about
  $1.27 of gross attributable usage and $0.20 net account cost after credits. The complete method,
  unit prices, and caveats are recorded in [the cost model](costs.md).

The default live tests use a deterministic mock agent and spend no model tokens. Setting
`AWS_E2E_REAL_CODEX=true` adds one bounded, two-turn paid persistence probe before the exit-trap
teardown.

## Known gaps

- Test private repository checkout and rotation of short-lived installation/project credentials.
- Expand real-agent validation beyond an exact-marker canary to repository analysis, bounded file
  changes, timeout, cancellation, and output-quality cases.
- Exercise cancellation, timeout, forced termination, launch failure, notifier ambiguity, DLQ
  redrive, and state-stream reconstruction under injected failures.
- Measure concurrency, service quotas, sustained load, and cost ceilings beyond the current
  single-conversation cold/warm baseline.
- Add outbound allowlisting/proxy controls if broad AWS-managed internet egress is unacceptable.
- Repeat image/lifecycle validation in every intended Region and after each service/provider upgrade.
- Replace the Teams Workflow bridge with an authenticated Entra/Bot/Teams SDK gateway.
- Validate teardown under injected failure and measure actual suspended-storage cost behavior.
- Add mid-command streaming/steering, active-session heartbeats and reconciliation, summarized
  context compaction, and an explicit agent handoff contract.
- Complete an independent IAM, snapshot, malicious-repository, SSRF, credential-boundary, and
  cross-owner security review.

## Roadmap

### 1. Production safety gates

- Add WAF/API throttles, per-owner concurrency/model budgets, stuck-run detection, and dashboards.
- Introduce short-lived source-control credentials and prevent arbitrary caller-selected secret ARNs.
- Prove output redaction, destination authorization, mention safety, and provider-loop controls.
- Drill both failure queues and document audited state repair.
- Scan/sign release bundles, generate SBOMs, and protect build provenance.

### 2. Expand the real-agent canary

- Validate Codex against an immutable repository task, then a dedicated private read-only repository.
- Compare output contracts, events, timeouts, cancellation, logs, latency, and cost.
- Expand only through allowlisted owners/repositories after explicit security and SLO approval.

### 3. Teams-primary product path

- Build the AWS-hosted Microsoft Entra/Bot/Teams SDK gateway described in
  [channels](channels.md#recommended-production-teams-gateway).
- Persist authorized installation/conversation references independently from run state.
- Add exact-thread streaming progress and signed human approval/cancel actions.

### 4. Conversation parity and resilience

- Add teardown-under-failure drills and measure suspended-session storage cost and lifecycle limits.
- Add safe mid-command steering, active-session heartbeat/recovery, compaction summaries, and
  handoff/replay tooling.
- Add policy-controlled tool profiles, usage/budget accounting, and richer output schemas.

## Reference provenance

The [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
informed lifecycle/image behavior. [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
informed the composition-root, provider-plugin, ingress, identity/credential, execution, delivery,
and durable-mailbox boundaries. Neither codebase is vendored; attribution is in
[`NOTICE`](../NOTICE).
