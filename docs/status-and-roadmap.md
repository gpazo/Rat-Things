# Status and roadmap

## Current maturity

This repository is an **engineering preview**, not a production-ready service. “Implemented” below
means the code path exists in this repository; test coverage varies by row. It does not mean the
feature has passed a production deployment, penetration test, quota exercise, disaster-recovery
test, or sustained-load test. The focused tests cover domain/core behavior, webhook
normalization/signatures, process and workspace safeguards, drivers, executor payloads, the
LocalStack data/event path, and a disposable live-AWS mock-agent path. The live test is not an
exhaustive provider, failure, load, real-model, or security exercise.

| Capability | Status | Notes |
| --- | --- | --- |
| Versioned run request and state machine | Implemented | Strict validation, conditional transitions, owner-scoped idempotency |
| Control API | Implemented | Submit/list/get/cancel plus owner-checked, short-lived artifact URLs; current response projection is internal |
| Durable AWS orchestration | Implemented and locally/live integrated | LocalStack covers the data-plane/event flow and Teams bridge; a disposable live-AWS run proved API Gateway, Lambda, DynamoDB Streams, SQS, EventBridge, S3, KMS, and empty failure queues, while replay/chaos drills remain |
| ECS backend | Live mock-agent validated | A disposable AWS test built/pushed the ARM64 image and completed control, signed GitHub, and signed GitLab runs in one Fargate task per run |
| Codex driver | Implemented in worker | Non-interactive ephemeral JSON mode; Amazon Bedrock deployment path needs end-to-end validation |
| Claude Code driver | Compatibility implementation | Binary/auth are operator supplied; currently ignores sandbox, reasoning-effort, and output-schema options |
| Mock driver | Implemented/tested | Default for deterministic local and initial remote infrastructure smoke tests |
| GitHub ingress/egress | Initial adapter | Signed PR/comment ingress, non-empty `@indubitably` default trigger, result-marker/bot loop guard, and PR comments; static token and author/repository policy remain gaps |
| GitLab ingress/egress | Initial adapter | GitLab 19 Standard HMAC with legacy-token fallback, non-empty `@indubitably` default trigger, result-marker/bot loop guard, and MR notes; static token and author/project policy remain gaps |
| Teams ingress/egress | Bridge only | Outgoing webhook plus Workflow URL; not an authenticated Teams app/bot gateway and not exact-thread proactive delivery |
| Slack ingress/egress | Optional initial adapter | App mentions and threaded result posts; not a primary deployment target |
| Lambda MicroVM backend | Opt-in live mock-agent validated | Terraform built image version 1 and its connector in `us-west-2`, then `RunMicrovm` cloned a pinned public GitHub commit, wrote output/state/events, and self-terminated on 2026-08-02; parity, failure, security, and real-model tests remain |
| Observability/recovery | Partial | Structured logs, terminal events, queue redelivery, queued-run reconciler, expiring delivery leases, and alarmed stream/notifier failure queues; broader dashboards, stuck-active reconciliation, and drills remain |
| Multi-tenant/public API hardening | Not complete | Requires response projection, destination/secret authorization, rate/budget controls, and security review |
| Production Teams experience | Not implemented | Recommended Teams SDK/Bot gateway is described in `channels.md` |

## What the reference projects contributed

The design review uses immutable revisions:

- [AWS Claude Code on Lambda MicroVMs
  `2a574ea941f44e36e9066dea7b131131139162e4`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
  informed lifecycle hooks, build/runtime connector separation, image bundling, snapshot hygiene, and
  explicit provisioning.
- [Sentry Junior
  `cc9bd538564639345717caf4a92a3ddef37f3274`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
  informed the separation of channel ingress, orchestration, agent execution, state, and outbound
  delivery.

This repository does not inherit Junior's Vercel deployment, make Slack primary, or claim its mature
conversation/retry behavior. It does not assume the AWS sample proves this repository's IAM,
network, image, or workload configuration. Attribution is in `NOTICE`.

## Roadmap

### Phase 0 — make the baseline repeatable

- Keep `npm run check` green from a clean clone and add CI for Node, Lambda packages, Docker ARM64,
  Terraform formatting/validation, and dependency/license scanning.
- Deploy a dev stack with the mock driver, submit through the signed control CLI, retrieve artifacts,
  cancel each active state, replay SQS/EventBridge deliveries, and destroy the disposable stack.
- Publish immutable worker image tags/digests and pin base images/dependencies.
- Add dashboard/alarms for queue age, DLQ depth, dispatch/start failures, active-run age, terminal
  failures, notifier failures/`outcome_unknown`, Lambda errors/throttles, and ECS task exits.
- Document quotas, cost ceilings, backup/restore, region recovery, and incident ownership.

### Phase 1 — secure ECS and provider beta

- Complete IAM/`iam:PassRole`, egress, SSRF/redirect, cross-owner, and malicious-repository reviews.
- Replace static GitHub/GitLab tokens with short-lived installation/project credentials and prevent
  arbitrary control callers from selecting secret ARNs.
- Add mention/command policy, tenant/repository allowlists, WAF/API rate limits, per-tenant
  concurrency/model budgets, and payload/output scanning.
- Prove non-empty triggers and result-marker/bot-author loop guards with live provider payloads; add
  per-thread recursion/cost alarms.
- Introduce an external-safe run projection and explicit authorization/audit for artifact downloads
  and named destinations.
- Add worker heartbeats/leases or a stuck-active reconciler with backend-state inspection; define
  retry semantics separately from transport redelivery.
- Drill the state-stream failure queue's sequence-range and current-run reconstruction paths after
  retry exhaustion; adopt a durable outbox if the proven recovery objective requires it.
- Run a real Codex-on-Bedrock ECS canary, cancellation/timeout chaos tests, provider sandbox tests,
  and load tests before any production traffic.

### Phase 2 — Teams-primary product path

- Build the AWS-hosted Microsoft Entra/Bot/Teams SDK gateway described in
  [channels](channels.md#recommended-production-teams-gateway).
- Persist authorized installation and conversation references independently from run state.
- Add tenant policy, exact-thread proactive completion, reply/update behavior, card fallback, and
  provider throttling/retry handling.
- Add explicit human approval/cancel actions with signed state-changing requests; never trust an
  Adaptive Card payload without service authentication and authorization.
- Retire the outgoing-webhook/Workflow bridge only after side-by-side tenant testing and rollback
  rehearsal. Slack remains optional.

### Phase 3 — controlled Lambda MicroVM preview

- Repeat the pinned managed-image build in every intended Region and review the source ZIP and image
  capabilities as release artifacts.
- Verify every lifecycle hook, hook-payload limit, snapshot hygiene rule, build connector, runtime
  connector, role, logs, termination path, and service quota against the current AWS documentation.
- Extend the proven single mock run into an identical ECS/MicroVM corpus covering real Codex,
  private checkout, cancellation, timeouts, failures, network policy, latency, and cost.
- Canary an allowlisted owner/repository subset. Keep ECS as rollback and avoid changing the default
  backend until canary SLOs and security gates pass.

### Phase 4 — subsystem capabilities

- Define versioned progress/event and retry contracts without changing v1 semantics.
- Add resumable conversation/thread state only after ownership, credential, retention, and context
  boundaries are explicit.
- Add policy-controlled tool profiles, structured result validation, richer provider review comments,
  and a first-class audit event model.
- Extract reusable Terraform environments/modules and a compatibility adapter for callers migrating
  from `indubitably-serverless`, without making the old repository a runtime dependency.

## Production-ready definition

Do not remove the preview label until all of the following are evidenced for the chosen backend and
channels:

- clean CI, immutable artifacts, provenance/SBOM, and rollbackable Terraform apply;
- least-privilege IAM and egress reviews with automated regression checks;
- cross-owner, prompt-injection, malicious-repository, webhook forgery/replay, and output-exfiltration
  test results;
- concurrency, queue-backlog, provider-throttle, timeout, cancellation, DLQ replay, and regional
  failure exercises;
- dashboards, actionable alarms, operator runbooks, cost budgets, retention, backup/restore, and
  incident response ownership;
- a production Teams app gateway if Teams is presented as the primary supported interface; and
- a staged migration with shadowing/canary evidence and a rehearsed webhook/API rollback.
