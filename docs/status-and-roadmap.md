# Status and roadmap

## Current maturity

Rat Things is an **engineering preview**, not a production-ready service. The focused tests cover
domain behavior, webhook signatures and normalization, process/workspace safeguards, drivers,
executor payloads, the LocalStack data/event path, a disposable live-AWS mock-agent path, and one
minimal Codex-on-Bedrock run in a live Lambda MicroVM. They do not constitute a penetration test,
quota/load exercise, broad real-agent evaluation, or disaster-recovery proof.

| Capability | Status | Notes |
| --- | --- | --- |
| Run contract and state machine | Implemented/tested | Strict validation, conditional transitions, owner-scoped idempotency |
| Provider plugin boundary | Implemented/tested | Trusted manifests bind ingress/delivery; dependency checks prevent authority inversion |
| Control API | Implemented/live validated | Submit/list/get/cancel and owner-checked short-lived artifact URLs |
| Durable AWS orchestration | Locally/live validated | DynamoDB, S3, SQS, Streams, EventBridge, notifier delivery, failure queues |
| Lambda MicroVM runner | Live Codex and mock validated | Sole backend; pinned public checkout, output/events/state, and self-termination passed in `us-west-2` |
| ECS replacement | Complete | Before removal, the same pinned checkout produced byte-identical output/events and equivalent execution metadata on the legacy task and MicroVM paths; the post-removal live suite then passed with no ECS/VPC fallback |
| Codex driver | Live validated | Pinned non-interactive ephemeral JSON mode; live AWS uses short-term Bedrock auth, while trusted local runs can reuse the device's ChatGPT subscription |
| Mock driver | Implemented/tested | Used for deterministic local and live infrastructure validation |
| GitHub/GitLab | Initial adapters | Signed ingress, loop guards, source-thread egress; credential and policy hardening remain |
| Teams | Bridge plus threaded gateway seam | Workflow delivery remains available; a real-Codex LocalStack simulation now preserves the exact source conversation/activity through a versioned reply-gateway contract, but Microsoft authentication and live tenant delivery remain |
| Slack | Optional initial adapter | App mentions and threaded posts; not the primary deployment target |
| Observability/recovery | Partial | Structured logs, durable queues/events, reconciler, delivery leases, failure queues/alarms; chaos drills remain |
| Multi-tenant hardening | Not complete | Requires safe response projection, destination authorization, budgets, rate limits, and security review |

## Validation completed on 2026-08-03

- TypeScript typecheck, unit/integration tests, architecture boundaries, Lambda/MicroVM packaging,
  and all Terraform formatting/validation gates.
- Disposable LocalStack end to end: signed GitHub/GitLab normalization and full signed Teams
  ingress-to-WireMock egress, including real LocalStack data/event services and durable fencing.
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

The default live tests use a deterministic mock agent and spend no model tokens. Setting
`AWS_E2E_REAL_CODEX=true` adds one intentionally small paid canary before the exit-trap teardown.

## Known gaps

- Test private repository checkout and rotation of short-lived installation/project credentials.
- Expand real-agent validation beyond an exact-marker canary to repository analysis, bounded file
  changes, timeout, cancellation, and output-quality cases.
- Exercise cancellation, timeout, forced termination, launch failure, notifier ambiguity, DLQ
  redrive, and state-stream reconstruction under injected failures.
- Measure concurrency, queue age, service quotas, latency, sustained load, and cost ceilings.
- Add outbound allowlisting/proxy controls if broad AWS-managed internet egress is unacceptable.
- Repeat image/lifecycle validation in every intended Region and after each service/provider upgrade.
- Replace the Teams Workflow bridge with an authenticated Entra/Bot/Teams SDK gateway.
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
- Add exact-thread proactive completion and signed human approval/cancel actions.

### 4. Subsystem capabilities

- Define versioned progress and retry contracts without changing v1 semantics.
- Add resumable conversation state only after ownership, credential, retention, and context
  boundaries are explicit.
- Add policy-controlled tool profiles, usage/budget accounting, and richer output schemas.

## Reference provenance

The [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
informed lifecycle/image behavior. [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
informed the composition-root, provider-plugin, ingress, identity/credential, execution, and
delivery boundaries. Neither codebase is vendored; attribution is in [`NOTICE`](../NOTICE).
