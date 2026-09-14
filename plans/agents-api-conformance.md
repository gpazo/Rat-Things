# Agents API conformance ledger

Target: `OpenAI-Beta: agents=v1`, `openai@7.15.0` and the public guides
reviewed on 2026-09-12. Native protocol baseline: `@openai/codex@0.154.0`.
The operator owns the endpoint, authentication, harness, storage, relay and
compute in AWS. Requested model identifiers and capabilities must preserve their
meaning. A provider substitution or an explicitly rejected supported upstream
request is a compatibility difference, not a passing conformance case.

The exhaustive route/request/response inventory is
[`spec/agents-api-routes.json`](../spec/agents-api-routes.json); runtime field
definitions are [`spec/schemas/agents-api.schema.json`](../spec/schemas/agents-api.schema.json).
Their generation checks catch SDK drift. The ledger below tracks behavior that
generated types cannot prove. "Local coverage" means implementation and targeted
checks exist, not that every edge case or a live deployment is verified.

The [current compatibility audit](agents-api-audit-2026-09-13.md) records the
working tree's unresolved checks and runtime availability. Earlier native-image
and deployment results below describe their original candidates; they do not
certify subsequent changes. Lambda MicroVMs remain a supported backend alongside
EC2, with S3 Files retained for Session state.

## Contract and evidence map

| Contract | Implementation | Existing evidence | Remaining acceptance |
| --- | --- | --- | --- |
| Agents CRUD, defaults, replacement, nullable fields, metadata | `agent-service`, `agent-configuration` | `sdk-conformance`; pinned native model-default catalogue | Resolved model reasoning defaults, disabled capacity null, object replacement and nullable resets covered; remaining field/limit comparison |
| Session creation, immutable resolved config, initial input, metadata, list/filter/delete | `session-service`, `session-planning`, `session-preparation-planning` | `session-lifecycle`, `session-preparation`, `sdk-conformance`, `session-journal`, `run-session-execution` | Saved Agent transport snapshots, concurrent preparation and commit acknowledgement recovery covered; one-day preparation expiry and concurrent abandonment/adoption covered locally and in the deployed cleanup consumer. Local closure-before-first-claim, concurrent claim/closure and delayed dispatch after HTTP deletion are covered; broader creation/deletion races and documented status/error/limit comparison remain |
| Input batches, active-turn steering, cancellation, function results, idempotency | `session-planning`, Session outbox | `session-lifecycle`, `run-session-execution` | Connection wait/deadline, 256-character idempotency boundary and saved-Turn acknowledgement after disconnection/harness shutdown covered. Local cancellation during an unacknowledged start preserves completed/failed outcomes and pending native cancellation; broader admission/steering races and deployed timing remain |
| Turns, Items, pagination, retained output, usage | `session-service`, `session-run-projection` | `session-lifecycle`, `session-runtime` | All Item variants, causal order, usage after compaction and child work |
| Live SSE, all event variants, connect-before-read recovery | `session-stream`, `session-service`, `session-event-store` | `transport-and-launch`, `session-lifecycle`, `webhooks`, `session-journal` | Durable ordered transitions, command deltas, stable identities, late subscriptions and deletion fencing covered; remaining event variants and deployed streaming remain |
| Outbound Session webhooks | `session-webhooks`, `webhook-service`, durable event/outbox adapters | `webhooks`, `webhook-http` | Five events, pre-wait action, SDK signatures, duplicates, DNS deadline, redirects and 72-hour horizon covered locally; earlier live HTTPS capture proved committed-event delivery; broader deployed retry/fanout evidence remains |
| Subagent CRUD/read surfaces and coordination items | `session-runtime`, runtime planning | `session-runtime`, `native-session` | Patched macOS and packaged Linux ARM64 runtimes pass strict limits 1/6, ten interrupted follow-ups at each limit and ten competing nested admissions; deployed execution remains |
| No-environment execution and declared tools | `session-launch-planning`, native harness | `native-session`, `transport-and-launch` | Earlier live admitted-model calls passed; expand absent-capability and provider coverage |
| Self-hosted executor connection and environment keys | `environment-service`, encrypted relay | `environment-relay`; live scoped registry/executor connection and 2 MiB deployed file-helper transfer | Broader disconnect/reconnect, deadlines, late connection and deployed owner/role isolation |
| Managed environments and templates | `environment-service`, `environment-template-service`, hosted runner | `vaults-and-templates`, `files-and-skills`, `managed-executor` | ARM64 setup, packages, capability loading, worker lifetime and replacement behavior |
| Idle harness continuation and execution loss | `run-session-execution`, MicroVM controller | Private executor/recovery tests, `run-session-execution`, `session-runtime` | Suspended continuation and reconnect admission fixed locally. Starts rejected before native admission remain retryable after initialization or root completion; ambiguous native starts still close the harness without replay. Shutdown races, checkpoint recovery and maximum worker lifetime remain |
| Environment Files, uploads, Skills and versions | File/Skill/environment services | `files-and-skills`, `environment-files`, `http-transport` | Every size/path/version boundary, large deployed transfers and disconnects |
| Saved Session artifacts | Session service and artifact capture | `session-lifecycle`, `session-publications` | Snapshot timing, documented size limits, child output, expired sandbox and deletion |
| Vault credential secrecy, rotation, deletion and OAuth | Vault service and credential adapters | `vaults-and-templates`, `vault-oauth` | Live token refresh/revocation and deployed IAM; SDK field/validation limits |
| MCP service/environment transports and metadata | `session-tool-service`, `session-tool-planning`, `session-mcp`, environment MCP bridge | `session-tools`, `session-preparation`, `session-tool-reconciliation`, `secrets-session-tools`, `agents-outbox`, `environment-mcp` | Durable reservations, adoption fencing and outbox cleanup cover uncertain creation, failed revocation and deletion interruptions locally. Managed stdio admission and self-hosted inline env rejection retained. Live Secrets Manager/KMS recovery, deployed stream/SQS cleanup with role IAM, and HTTP Session credential lifecycle passed. One-day abandonment fencing and credential retirement passed locally and through the deployed outbox; the scoped deployment inventory found no active unreferenced inline credentials. Real configured servers, reconnect, broader failure outputs, older-deployment inventory and abandoned environment disposition remain |
| Functions, programmatic tools, deferred tool search, web search | Agent config and launch planning | Real native programmatic/deferred function round trips against local model fixtures, including required actions and results; launch tests | Admitted live provider calls and web-search results |
| Authentication, errors, HTTP bodies, multipart, SSE transport | Agents routers, token issuer, direct HTTPS HTTP server | `http-transport`, `sdk-conformance`, `transport-and-launch` | Full reference error/default review and deployed LB timing; public API bypasses CloudFront's shorter response timeout |

Source guides:

- [Configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration)
- [Sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions)
- [Events and Items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [Session webhooks](https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks)
- [Webhook delivery and signatures](https://developers.openai.com/api/docs/guides/webhooks)
- [Sandbox lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle)
- [API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents)

## Execution gates

1. Close known missing behavior: durable webhooks, suspended continuation, and
   event preservation. Keep event calculation pure and commit effects explicit.
2. Review each ledger row against its guide and generated field definitions;
   record focused counterexamples as tests and fix them. Unreviewed or explicitly
   unsupported behavior remains open. Do not infer full coverage from test counts.
3. Run repository checks, local console/protocol tests, LocalStack and ARM64 image
   tests. Replace retired provider/schedule/publication/recovery canaries with
   canonical Session scenarios, and finish dependency-safe obsolete code removal.
4. After local parity, run the user-authorized live AWS end-to-end cycle with real
   admitted model calls. Verify dedicated HTTP/relay transport, environment setup,
   credentials/IAM, lifecycle/recovery, webhooks, providers, schedules and artifacts.
   Preserve diagnostic evidence and clean up disposable proof resources.
5. Only claim parity when every public behavior row has passing evidence and no
   unresolved difference. AWS failures discovered by the live cycle reopen the
   relevant rows. Retained production-data deletion is a separate disposition
   decision, not a prerequisite for public API compatibility.

The user has authorized live AWS testing after parity. Earlier handoff language
that limited work to local checks does not override that authorization. Existing
production data, unrelated resources and model credentials remain outside cleanup.

## Known blockers and precise follow-up

- **Native artifact rollout:** the stock `0.154.0` binary rejected seven of ten
  limit-one interrupted follow-ups. The completion-barrier patch now passes all
  ten attempts at each limit (1 and 6), and ten competing nested admissions on
  macOS and Linux ARM64. Exact capacity excludes the coordinator. The complete,
  digest-verified Linux package passed all 148 strict fixtures as UID 10001 inside
  the worker image. The isolated AWS deployment now passes real admitted-model
  API and managed-worker Turns. Deployed multi-agent capacity/interruption cases
  remain open; see `aws-live-validation.md`.
- **Managed sandbox lifetime:** Lambda MicroVMs permit at most 28,800 seconds;
  they cannot satisfy indefinite connected-process continuity. The dedicated ARM64
  EC2 Session worker uses host-managed lifetime and fenced TTL renewal, with local
  coverage across nine simulated hours. The live canary preserves a background
  process across Turns and offers an eight-hour-plus soak. Host bootstrap, IAM,
  mounts, guest isolation, short process continuity and shutdown passed in AWS.
  The eight-hour-plus case and replacement-worker recovery remain open. EC2
  workers refresh scoped Bedrock bearer tokens through native command auth.
- **Recovery:** native checkpoints remain preferred. Public-item fallback now
  retains all supplied Item variants, pairs completed functions within their Turn,
  gives recovered pairs distinct native IDs, and preserves incomplete/orphaned
  calls plus command/MCP/coordination records as labeled historical data. The stock
  harness fixture receives these facts without replaying tools or reopening children.
  This fallback does not recreate live processes, hidden native context or child
  runtime state; deployed checkpoint-loss and replacement behavior remain acceptance
  work.
- **Container verification:** LocalStack 4.14.0 passed all four canonical workflow
  tests including provisioning and cleanup. The final ARM64 worker passed trusted
  runner/guest environment isolation, lifecycle-port denial with external port 8080
  access preserved, Chromium interaction and screenshots, private-address denial,
  and strict VP8 WebM validation. All 148 strict native image fixtures passed.
  These close the local container gates; they are not deployed AWS evidence.

The direct API hostname terminates TLS at the ALB and uses a 360-second idle
timeout. CloudFront still serves the executor relay. This avoids requiring a
CloudFront response-timeout quota increase for the five-minute input wait; see
[AWS origin timeouts](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html).

## Runtime implementation follow-up

1. Keep the accepted Linux ARM64 artifact and images pinned in the isolated
   AWS test deployment. Preserve the strict repeated interruption and concurrent
   admission fixtures and the matching upstream companion binaries/resources.
   Packaging checks source/patch identity, every file digest, package metadata and
   Linux ARM64 executable headers. See `agents-api-validation.md` for exact hashes.
2. Validate the new dedicated ARM64 EC2 Session worker. It is opt-in behind
   `enable_ec2_worker`, with immutable AMI/image inputs, encrypted EBS, no inbound
   worker networking, root-only IMDS access, and a durable private command mailbox.
   The trusted runner now stays root and drops Codex/repository commands to UID
   10001. Command claims precede effects and are never replayed after an ambiguous
   acknowledgement; control requests carry the intended public Turn ID.
   The EC2 harness uses host-managed lifetime and renews private Run TTL on fenced
   heartbeats. Live host bootstrap, IAM, metadata denial, mounts, short process
   continuity and shutdown passed. Verify native processes past eight hours and
   recovery. Fargate cannot directly host the current
   privileged mount/network controls, so it is no longer the selected worker design.
3. Use the already-authorized AWS deployment/e2e cycle to complete outstanding
   behavior rows. Include real admitted-model calls,
   multi-agent interruption and exact limits, input/recovery races, long-lived
   sandbox work, explicit artifacts/publications, provider/schedule delivery,
   webhook retries and large streaming/file traffic. Initial live API, console,
   managed-worker, webhook, five-minute streaming and maximum Files proofs passed;
   the live ledger records exact scope and evidence.

## Current native candidate

`runtime/codex/source.json` pins the exact 0.154.0 release commit plus a mechanical
workspace-version lock repair and an interruption completion-barrier patch. The
reproducible builder records source, patch and binary digests. Stock repeated
strict probes reproduced seven interruption/follow-up failures in ten limit-one
attempts; all ten competing nested-admission probes passed. The complete patched
macOS ARM64 runtime and Linux ARM64 worker image each passed 148 strict tests,
including programmatic and deferred function round trips. Deferred tools retain
their native namespace without changing public function names. Linux egress probes
use an explicit HTTP Agent and verify allowlist denial without DNS; this avoids
Node automatically proxying an already-proxied request. The earlier patched AWS
worker was deployed and passed the managed canary in `aws-live-validation.md`.
Current working-tree/native-image acceptance remains separately tracked in the
compatibility audit.

The token issuer now has an independent composition and IAM role. HTTP and outbox
permissions are separate from provider administration. The cloud worker no longer
restores or publishes the old Run artifact catalog and explicitly flushes the
Session journal before private Run finalization. Local CLI artifact collection and
retained deployed resources remain intentional.
