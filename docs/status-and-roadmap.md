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
| Run contract and state machine | Implemented/local and live AWS validated | One receipt and lifecycle across raw, Thing, schedule, provider, and threaded ingress; strict validation, conditional transitions, owner-scoped idempotency, and crash-window recovery |
| Provider plugin boundary | Implemented/tested | Trusted manifests bind ingress/delivery; dependency checks prevent authority inversion |
| Control API | Core live validated; browser event/approval path live validated | Submit/list/get/cancel, artifacts, live events/steer/interrupt/approval/response, integrations, profiles, and routines |
| Thing facade | Implemented/local and live AWS validated | Credential-free immutable definitions, explicit draft/active pointers, revision-evidenced test/run receipts, test/publish/run/pause/resume/archive lifecycle, manual and EventBridge Scheduler rate/cron triggers, explain diagnostics, and idempotent invocation |
| Durable agent files | Implemented/live validated | `.rat-things/artifacts/` outbox, immutable S3 bytes, conversation catalog restoration, and CLI list/24-hour URL/download commands passed in a real Codex MicroVM |
| File/site/video publications | Implemented/live validated | Agent-declared publishing, content-derived reuse, manifest-last commit, isolated wildcard hosts, CloudFront OAC, signed redemption, and API/CLI commands passed recipient-open validation |
| Durable AWS orchestration | Locally/live validated | DynamoDB, S3, SQS, Streams, EventBridge, EventBridge Scheduler, notifier delivery, retries, and failure queues |
| Conversation mailbox | End-to-end locally/live validated | Teams ingress, DynamoDB/S3 mailbox, interrupt/defer ordering, leases, SQS coordinator, durable replay, terminal completion, expiry fallback, and crash-window repair |
| Lambda MicroVM runner | One-shot/resume/replacement live validated | Same-ID suspend/resume plus S3 Files workspace restoration in a replacement VM passed in `us-west-2` |
| ECS replacement | Complete | Before removal, the same pinned checkout produced byte-identical output/events and equivalent execution metadata on the legacy task and MicroVM paths; the post-removal live suite then passed with no ECS/VPC fallback |
| Codex App Server bridge | Core live validated; expanded protocol simulated and local-live tested | Thread start/resume, turn control, events, approvals/server requests, reasoning/personality, skills, apps, MCP config, and experimental dynamic tools |
| Capability profiles | Implemented/locally tested | Deployment ceiling plus `read-only`, `small-business`, and `microvm-full`; requests can narrow but not widen profiles |
| Integration Contract v1 | Implemented/local and live AWS validated | Manifest-driven credential-only CLI/API onboarding, pre-persistence verification, provider-derived account identity/access/scopes, stable invalid-credential errors, and verified rotation |
| Multi-account integrations | Implemented/local and live AWS validated | Owner-scoped connections, Secrets Manager vault, grants, same-plugin account sets, source bindings, permission intersection, resource constraints, revocation, and approvals |
| Reference integration tools | Built-ins locally tested; fixture live AWS validated | Fixed-origin Slack search/post/reaction and Stripe customer/invoice/refund adapters; disposable Fixture CRM proves authenticated read/write behavior without claiming customer-provider coverage |
| Browser computer use | Implemented v1 surface/live AWS validated | Real Codex exercised all 12 implemented command types, four interactive approval types, PNG/JPEG capture, VP8 WebM recording, private-target blocking, native cgroup eBPF lifecycle-port isolation, and trusted publication from an ARM64 Lambda MicroVM; takeover/auth/file transfer/desktop control remain out of scope |
| Durable routines | Implemented/local end-to-end and simulated | Owner-scoped interval create/list/get/pause/resume/delete/run-now, encrypted S3 request, due-time GSI, deterministic occurrence submission, duplicate-tick fencing, and request-digest verification |
| Codex authentication | Live/local validated | Short-term Bedrock in AWS; trusted local runs can reuse the device's ChatGPT subscription without copying it into remote runs |
| Mock driver | Implemented/tested | Used for deterministic local and live infrastructure validation |
| GitHub/GitLab | Initial adapters | Signed ingress, loop guards, source-thread egress; credential and policy hardening remain |
| Teams | Durable chat path locally/live AWS validated | Signed mentions get an immediate acknowledgement, enter the mailbox, and complete through threaded gateway egress; Microsoft authentication and live tenant delivery remain |
| Slack | Optional initial adapter | App mentions and threaded posts; not the primary deployment target |
| Observability/recovery | Partial/live measured | Low-cardinality queue/processing metrics, structured logs, durable queues/events, reconciler, delivery leases, failure queues/alarms; broader chaos drills remain |
| Cost model | Live canary baseline measured | The 2026-08-16 two-turn site canary has a dated $0.380 estimate using rates captured then; non-model infrastructure was about $0.046, while current repricing and sustained-load ceilings remain unmeasured |
| Multi-tenant hardening | Not complete | Requires safe response projection, destination authorization, budgets, rate limits, and security review |

## Golden-path validation completed on 2026-08-24

- A clean clone of immutable tag `golden-path-v1.0.0`, commit `f1c5487`, ran the documented
  `npm run quickstart:aws` journey from fresh
  dependency installation through a 158-managed-resource disposable `us-west-2` deployment. A real
  `openai.gpt-5.6-terra` Run tested the exact draft, publication pinned its revision and `specHash`,
  and a second real Run invoked that published active revision. The complete measured command,
  including the interactive confirmation wait, passed in 402 seconds (6m42s). The evidence records
  the host OS and exact Node, npm, Git, Terraform, and AWS CLI versions.
- `status` and `destroy` were then invoked without repeating the AWS profile or Region; both reused
  the saved non-secret context. Status found the healthy API, exact active Thing, no unpublished
  revision, and latest Run. Destroy removed the deployment and verified zero state entries and zero
  active MicroVMs. An independent state and AWS control-plane check found zero deployed instances,
  all 11 historical MicroVMs terminated, and the exact disabled KMS key in `PendingDeletion`.
- A separate fresh predecessor-tag clone was intentionally recovered after the workstation filled its disk
  while Terraform downloaded providers, before any AWS write. Status reported `incomplete`; generic
  destroy reused the stored identity context and verified an empty state and no active MicroVMs.
- The immediately preceding live deployment proved the universal execution path with two named-thread CLI turns.
  Each accepted prompt returned one Run. The first Run executed the coordinator-prepared input; the
  second continued from suspended-session state and executed a transcript containing the first user prompt,
  first result, and follow-up prompt.
- That continuation test exposed and fixed an AWS resume race: the lifecycle proxy could accept a
  Run before AWS completed its own resume hook, then terminate the MicroVM and strand the Run in
  `dispatching`. Dispatch now waits for AWS to report `RUNNING` and launches a replacement if the
  resumed session becomes terminal. A focused regression test covers the fallback.
- A clean Docker/LocalStack deployment passed all six workflows after the immutable accepted input
  and coordinator-prepared `executionInput` assertions were separated. The signed Teams case proves
  raw prompt immutability, full replay preparation, one Run per message, state transitions, and
  threaded delivery.
- The sanitized [project-published evidence bundle](aws-quickstart-evidence.json) pins the immutable
  source, host toolchain, Thing, both Run receipts, exact elapsed milliseconds and rounding, status
  check, teardown, and independent postcheck. It is unsigned project evidence, not a third-party
  attestation, and its destroyed resource IDs are historical receipts rather than live query targets.

## Validation completed on 2026-08-23

- A fresh 226-resource disposable `us-west-2` stack (`sch260823b`) passed all eight applicable
  live-AWS workflows in 273.18 seconds. The separate real-Codex restoration,
  real-integration-write, and browser-publication scenarios were the three expected opt-in skips;
  each already has dedicated live evidence recorded below.
- The Thing journey created draft revision 1, tested the draft, published it as the exact active
  revision, and created a real EventBridge Scheduler `rate(1 minute)` schedule with a fixed Lambda
  target and invocation role. AWS fired the schedule at its actual context time; the resulting run
  pinned the expected Thing ID, immutable revision, scheduled time, and occurrence idempotency key,
  completed in a Lambda MicroVM, and left the schedule failure queue empty.
- The same test inspected the deployed schedule, proved that pause disabled it, resume enabled it,
  archive removed it, and a stale or duplicate occurrence could not submit additional work. The
  broader suite also revalidated signed provider ingress, the revisioned multi-account Thing API,
  same-VM and CLI conversation continuation, replacement-VM fallback, coordinator crash repair,
  and repository-backed execution.
- Docker/LocalStack passed all six workflows, including the trusted scheduled-invocation handler.
  The complete local gate passed 61 files and 257 tests with 18 intentional opt-in skips; all 13
  ARM64 Lambda bundles packaged and smoke-loaded, the 21-page documentation site built, and all
  three Terraform configurations validated.
- Teardown terminated six MicroVMs and destroyed all 226 Terraform resources. The post-destroy tag
  audit found only resources already gone, terminal, or deleting. AWS disabled the customer-managed
  KMS key and scheduled its mandatory delayed deletion.

## Validation completed on 2026-08-22

- A fresh 216-resource disposable `us-west-2` stack (`int260822a`) passed all ten applicable
  workflows with `AWS_E2E_REAL_CODEX=true`; only the optional custom-domain browser-publication case
  was skipped because no publication domain was configured. The suite completed in 460.85 seconds.
- The built CLI discovered Fixture CRM authentication fields, rejected an invalid credential before
  persistence, then connected two distinct accounts from credential-only files. The API derived
  `Alpha Support` with provider read/`records:read` authorization and `Beta Support` with provider
  full/`records:read`+`records:write` authorization. It never accepted caller-authored tenant,
  subject, or scope claims.
- A real Codex agent selected the read-only Alpha account for search and the read/write Beta account
  for create. The owner-checked event API surfaced exactly one
  `ratThings/integration/requestApproval` for `fixture-crm.records.create`; the harness accepted it,
  the provider audit queue recorded exactly one mutation, and the run succeeded. Neither credential
  appeared in stored run state, output, or events.
- The same suite repeated revisioned Things and permission explanation, an actual EventBridge
  occurrence, same-MicroVM conversations, built-CLI continuity, expired-MicroVM replacement,
  coordinator crash repair, repository checkout, and real Codex thread/workspace restoration.
- A second fresh stack (`int260822b`) reran the focused integration journey after the final
  credential-error and rotation changes. In 22.78 seconds it proved the exact `400 invalid_request`
  contract, manifest-driven CLI onboarding for both accounts, effective-permission explanation, a
  real Lambda MicroVM Thing run, credential-only CLI rotation, and revocation.
- Docker/LocalStack passed all five workflows, including the provider-verification and same-plugin
  multi-account path. The complete unit gate passed 60 files and 254 tests with 17 intentional
  opt-in skips; 12 ARM64 Lambda bundles packaged and smoke-loaded successfully.
- Teardown destroyed both 216-resource disposable stacks and their Terraform states are empty. The
  independent tag audits found no active resources; each customer-managed KMS key follows AWS's
  mandatory disabled `PendingDeletion` lifecycle.

## Validation completed on 2026-08-21

- A fresh 208-resource disposable `us-west-2` stack (`ev260821a`) passed ten applicable workflows;
  only the custom-domain browser-publication case was skipped because that optional DNS fixture was
  not configured. The earlier reconciler-based implementation submitted exactly one scheduled
  Thing occurrence without an explicit `/run` call. The resulting durable run retained the expected Thing,
  revision, scheduled-time, and source provenance, completed in a Lambda MicroVM, and left the
  scheduler and failure queues clean. The focused scenario passed in 143.27 seconds.
- With the real-Codex option enabled, a Codex agent selected the authorized Slack account and called
  the production dynamic tools against Slack's actual API. The credential-free `api.test` operation
  succeeded and echoed a unique marker; the subsequent credentialed message search reached Slack
  and returned its expected `invalid_auth` denial for the deliberately disposable invalid token.
  The 16.23-second test proved successful provider I/O, brokered credential use, provider-side error
  propagation, read-only operation restriction, and absence of the credential value from durable
  run state, output, and events. It does not claim authenticated access to workspace data.
- The `ev260821a` teardown removed runtime-created secrets, terminated seven MicroVMs, destroyed all
  208 Terraform resources, and passed its tagged-resource audit. Independent checks found zero
  Terraform resources and no generated runtime environment file. AWS disabled the customer-managed
  KMS key and scheduled its mandatory delayed deletion.
- A fresh 208-resource disposable `us-west-2` stack (`th260821c`) passed all seven applicable live
  workflows; the custom-domain publication and paid real-Codex cases were the two expected opt-in
  skips. The new live Thing scenario used public discovery/OpenAPI/schema endpoints, registered two
  separately credentialed Slack accounts, grouped them in one connection set, and proved provider
  authorization, persistent grants, per-Thing narrowing, capability-profile narrowing, and
  per-operation explanation without returning secret values.
- The same scenario created two immutable Thing revisions, verified the owner-scoped definition
  bytes and SHA-256 digest in a dedicated versioned S3 bucket, and confirmed `aws:kms` object
  encryption with the deployment key. It submitted an idempotent Thing invocation through the
  production API, SQS dispatcher, and actual Lambda MicroVM mock runner; the resulting run retained
  trusted Thing ID/revision provenance and the resolved two-account policy. The lifecycle operations
  then in place, credential rotation, and revocation also passed against real AWS services.
- A clean Docker/LocalStack deployment passed all five workflows. Its Thing path covered two
  same-plugin accounts, Secrets Manager reference/value separation, connection-set selection,
  immutable definition storage, historical revision retrieval, explain diagnostics, duplicate
  invocation/wake-up fencing, run compilation, SQS dispatch, and host worker completion.
- The complete local gate passed 60 test files and 247 tests with 17 intentional opt-in skips.
  Architecture and TypeScript checks, MicroVM syntax, 11 packaged Lambda smoke tests, the 20-page
  documentation build, Terraform formatting, all three Terraform validations, and exact equality
  between the 58 OpenAPI operations and 58 deployed API Gateway routes were green.
- Teardown removed runtime-created connection secrets, terminated six MicroVMs, and destroyed all
  208 Terraform resources. The post-destroy tagged-resource audit passed for the managed image,
  connector, NAT gateway, VPC endpoints, and KMS key. As required by AWS, the disabled
  customer-managed KMS key remains only in its mandatory scheduled-deletion state.
- A second disposable `us-west-2` stack (`br260821b`) expanded the live browser proof from simple
  navigation to every implemented v1 command. A real Codex agent invoked `navigate`, `observe`,
  `record_start`, clear and append `type`, `press`, `select`, coordinate and reference `click`,
  full-page and viewport `screenshot`, `wait`, `back`, `scroll`, and `record_stop`. It submitted the
  Selenium web form twice, including Enter-to-submit, verified the exact query values, and restored
  page history after a long-page scroll.
- Owner-checked event polling surfaced and accepted distinct `type`, `press`, `select`, and
  coordinate-`click` requests with `accept-for-session`. The test verified that the click approval
  contained numeric viewport coordinates. An initial lifecycle-proxy HTTP 502 exposed a control
  API startup race; gateway startup responses now map to retryable interaction conflicts and the
  exact behavior has a unit test.
- The successful run retained a 59,298-byte PNG, 10,746-byte JPEG, and 1,547,168-byte WebM. FFprobe
  confirmed a 23.8-second, 1280x720, 5 fps VP8 stream; local SHA-256 values matched the trusted S3
  catalog. Three distinct publication hosts returned generated image/image/video viewers and
  byte-identical assets. Both screenshots and a six-frame video contact sheet were visually
  inspected. The focused live test passed in 252.66 seconds.
- The expanded ARM64 image canary independently exercised the same command set plus private-address
  denial and lifecycle-port isolation. It exposed missing labels/state for select, textarea,
  checkbox, and radio controls; the DOM snapshot now includes associated labels, names, values,
  checked state, and selected text. Its strict media checks passed a 57,778-byte PNG, 10,746-byte
  JPEG, and 299,570-byte VP8 WebM with 29 frames.
- The live recorder also established a performance limit: finalizing the 23.8-second WebM consumed
  168 seconds. Recording correctness is proven, but encoder latency remains an engineering-preview
  issue and long recordings should not be marketed as production-hardened.
- The `br260821b` teardown destroyed all 199 Terraform resources. An independent post-destroy audit
  found empty Terraform state, no publication DNS records or retained buckets, and no CloudFront
  distribution, API, MicroVM image, network connector, S3 Files file system/access point, active NAT
  gateway, or VPC endpoints. AWS placed the disabled customer KMS key in `PendingDeletion` for
  2026-09-20, its mandatory delayed path. The first teardown scan exposed a transient MicroVM
  control-plane HTTP 502; the termination helper now retries transient throttling, 5xx, timeout, and
  network failures, and the live teardown rerun completed successfully.
- A fresh disposable `us-west-2` stack (`br260821a`) ran the browser path through a real Codex
  agent in ARM64 Lambda MicroVM image version 2.0. The agent navigated to `example.com`, started a
  recording, clicked the visible link to IANA, captured the final page, finalized the recording, and
  declared both retained artifacts for sharing. The production event stream contained
  `navigate`, `record_start`, `click`, `screenshot`, and `record_stop` dynamic-tool calls.
- Trusted orchestration cataloged a 75,119-byte JPEG and a 770,771-byte VP8 WebM, created distinct
  publication hosts, redeemed both complete bearer URLs, received the generated image and video
  viewers, and fetched byte-identical `image/jpeg` and `video/webm` assets. The final screenshot and
  representative video frames were visually inspected; they show Example Domain before the click
  and IANA's Example Domains page afterward.
- Strict FFprobe validation confirmed a 4.8-second, 1280x720, 5 fps VP8 stream with no WebM/EBML
  diagnostics. That check first exposed padding inserted by `webm-writer`'s Node file-descriptor
  backend. The browser host now uses the bounded in-memory encoder result and atomically persists
  its exact byte range; the ARM64 image canary fails on any FFprobe diagnostic when the utility is
  installed.
- Seven of the eight live workflows passed together on image version 2.0, including persistent and
  replacement MicroVM sessions, the built CLI, coordinator recovery, repository execution, real
  Codex thread/workspace restoration, and browser publication. The remaining signed-ingress case
  then passed after its assertion was corrected to redeem the publication viewer before fetching
  `assets/output`; all eight scenarios were therefore exercised successfully on the same stack and
  image.
- The focused browser, runner, and simulation suites passed 10/10 tests. The packaged ARM64 image
  canary additionally proved browser navigation, screenshot and recording output, strict media
  structure, private-address denial, and UID-scoped lifecycle-port isolation.
- The complete local quality gate passed 54 test files and 223 tests, with 14 intentional opt-in
  skips. Architecture, typecheck, MicroVM syntax, Lambda packaging/smoke tests, the 17-page docs
  build, Terraform formatting, and root/LocalStack/live-AWS Terraform validation were all green.
- The `br260821a` teardown terminated seven MicroVM instances and destroyed all 199 Terraform
  resources. An independent post-destroy check found zero Terraform resources, publication DNS
  records, or retained buckets; CloudFront, the MicroVM image, and the network connector were gone.
  AWS placed the disabled customer KMS key in `PendingDeletion` for 2026-09-20, its mandatory delayed path.

## Validation completed on 2026-08-20

- A deterministic App Server agent-loop simulation invoked two separately credentialed Slack
  accounts and browser navigation/input through the production dynamic-tool dispatcher. It proved
  read-only versus read-write account selection, provider-scope intersection, resource constraints,
  integration and browser approval routing, host-side credential reads, and absence of credential
  values from App Server JSON-RPC events.
- A boundary-spanning routine simulation used the real `RoutineService` and `RunService` with
  durable-port fakes. Concurrent duplicate ticks produced one semantic run, preserved capability
  and connection policy, and rejected a tampered stored request before queueing. This test exposed
  and fixed unstable manual-run retry identity: the same idempotency key now produces the same
  canonical request even when retried later.
- The repository-pinned Codex CLI 0.146.0 used this device's authenticated ChatGPT session through
  Rat Things' real App Server bridge. A basic turn returned `RAT_THINGS_APP_SERVER_E2E_OK`; a
  repeatable E2E then required the real model to issue `item/tool/call` for a host dynamic tool and
  return its unpredictable marker exactly once.
- The full local suite passed: 53 passing test files and 218 passing tests, with 3 opt-in files
  containing 13 intentional Codex/AWS/LocalStack skips. Architecture, typecheck, Node syntax checks,
  11 Lambda bundle smoke tests, 16-page site generation, Terraform formatting, and
  root/LocalStack/live-AWS Terraform validation also passed.
- A clean Docker/LocalStack run passed all five workflows. It exercised two same-plugin accounts,
  Secrets Manager value/reference separation, connection-set defaults, routine API submission,
  duplicate idempotent wake-ups, encrypted S3 request bodies, DynamoDB/SQS dispatch, and worker
  completion. It also passed signed GitHub/GitLab ingress, the interruptible conversation mailbox,
  and the complete signed Teams-to-WireMock result path. The run exposed and fixed eager MicroVM
  construction on integration-only API routes, isolated mock `CODEX_HOME` cleanup, and a batched
  SQS receipt-handle bug in the E2E harness.
- The packaged ARM64 MicroVM image built and passed a repeatable Docker-gated canary. Its native
  cgroup eBPF policy allowed the root-owned lifecycle proxy to reach guest-local TCP 8080 while
  rejecting UID 10001 through loopback and the guest's own interface addresses; that same untrusted
  UID could still reach an unrelated external service on TCP 8080. Bundled Chromium then rendered
  `https://example.com`, exposed visible text and an element ref, captured a bounded JPEG, and
  rejected loopback navigation. The canary exposed and fixed missing NSS/NSPR and font/rendering
  packages in the minimal image. Disposable-AWS browser execution was completed on 2026-08-21.
- A fresh 186-resource disposable stack (`rt260820h`) then passed all seven live workflows in
  `us-west-2`: the control API and signed GitHub/GitLab/Teams paths, persistent same-MicroVM Teams
  continuation, two turns through the built Rat Things CLI, expired-session replacement,
  coordinator crash recovery, repository-backed execution, and a real two-turn Codex persistence
  probe. The live test phase completed 7/7 in 358.51 seconds with empty failure queues.
- The real Codex probe required actual shell tool calls. Its first turn created and verified a
  unique workspace file and emitted a matching workspace patch; after the test terminated that
  MicroVM, a replacement MicroVM resumed the same Codex thread and read the retained bytes without
  recreating the file. Both command-execution event streams and both terminal EventBridge events
  were asserted.
- The preceding live attempts exposed and fixed two idempotency races: recursively canonical policy
  comparison now tolerates DynamoDB map-key reordering, and a duplicate conversation message keeps
  its original `defer`/`interrupt` delivery decision even if the coordinator binds an active turn
  between submissions. The exact latter race is now covered through signed Teams ingress in the
  five-workflow LocalStack suite.
- Teardown terminated seven MicroVMs and destroyed all 186 Terraform resources. A post-destroy
  direct-service audit found no VPC endpoints, non-deleted NAT gateways, or active instances for
  the deleted image. AWS disabled the customer KMS key and scheduled its mandatory delayed deletion
  for 2026-09-19. The destroy helper now rescans for late-starting MicroVMs before every retry and
  requires two consecutive empty instance-list passes.

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
- The two-turn estimate captured on 2026-08-16 was about $0.380: $0.334 model inference and about
  $0.046 other infrastructure. GPT-5.6 Terra pricing has since changed; the retained aggregate
  token buckets cannot be honestly repriced without per-request context classification.
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
- Add hosted OAuth authorization-code/PKCE callbacks and token refresh for hosts that want Rat to
  own that lifecycle. Current connections accept already-issued credentials, verify them, derive
  provider tenant/subject and account labels, and keep OAuth application ownership with the host.
- Tie source-binding creation to a verified provider installation/account. It is currently a trusted
  operator action and should not be delegated to arbitrary tenants.
- ChatGPT subscription reuse remains a trusted-device local path. Remote AWS MicroVMs use short-term
  Bedrock authentication; securely delegating a personal Codex session without exposing reusable
  account credentials to model-driven code is unsolved here.
- Turn the trusted TypeScript integration contract into a documented SDK and add more adapters. There
  is no signed package catalog, arbitrary runtime plugin loading, visual mapper, or Zapier-compatible
  trigger engine yet.
- Run live AWS canaries for steering, interruption, decline/cancel decisions, Codex approval,
  scheduled routine submission, scheduled-Thing retry/crash injection, and authenticated customer
  provider accounts. Integration approval routing, verified multi-account resolution, permission
  intersection, and permitted authenticated fixture reads/writes are live validated without
  requiring customer-supplied accounts.
- Add browser takeover/return-control, secure human credential entry, uploads/downloads, tabs and
  popups, richer pointer interactions, and replacement-MicroVM authenticated-profile validation
  before making an unqualified “full computer use” claim. General graphical desktop control is not
  implemented.
- Replace or optimize the current WebM encoder; the live 23.8-second/119-frame recording was valid
  but required 168 seconds to finalize.
- Add a reviewed outbound proxy/DNS policy and browser-origin audit. Private-address checks do not
  prevent exfiltration to attacker-controlled public origins or replace Chromium escape testing.
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
- Add active-session heartbeats and reconciliation, summarized context compaction, and an explicit
  agent handoff contract. Live polling/steering/interrupt/approval is implemented for active runs.
- Complete an independent IAM, snapshot, malicious-repository, SSRF, credential-boundary, and
  cross-owner security review.

## Roadmap

The immediate priority is to make the new small-business/self-hosted surface boringly reliable:

1. Exercise live steering, interruption, negative approval decisions, Codex approval, and
   integration approval against one active run. Event polling and accepted browser approvals are
   already live validated.
2. Extend the now-live two-account fixture proof with explicit provider-scope denial and resource
   constraint cases, then repeat the conformance journey for each built-in provider when operators
   supply disposable accounts. Permitted read, approval-gated write, account selection, rotation,
   revocation, exactly-one mutation, and no secret leakage are already proven.
3. Prove the EventBridge reconciler submits one and only one scheduled routine occurrence, and
   extend the scheduled-Thing proof across injected retry/crash windows. Then exercise the routine
   lifecycle through the built CLI. A normal scheduled Thing occurrence and its lifecycle/provenance
   path are now live validated.
4. Add an optional BYO-OAuth helper for hosts that want authorization-code/PKCE and refresh support.
   Manifest-driven credential onboarding, provider verification, derived account labels, and stable
   invalid-credential errors are complete; hosted consent remains deliberately deferred.
5. Extract the fixed-origin adapter pattern into a contributor-facing SDK, schema validator, and
   conformance suite before expanding the app catalog.
6. Add browser and integration audit events, output redaction, destination authorization, budgets,
   and per-owner rate/concurrency limits appropriate for self-hosted small businesses.
7. Expand real-agent and failure-injection coverage, then publish a repeatable release checklist and
   measured cost envelope.

Deferred by product choice until the core above works well:

- enterprise-specific governance, organization administration, compliance packaging, and sales-led
  controls; and
- a separate always-on/Node execution tier. Lambda MicroVM remains the only remote backend.

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
- Surface exact-thread progress plus signed human approval/cancel actions using the implemented live
  control API.

### 4. Conversation parity and resilience

- Add teardown-under-failure drills and measure suspended-session storage cost and lifecycle limits.
- Add active-session heartbeat/recovery, compaction summaries, and handoff/replay tooling around the
  implemented mid-command controls.
- Add usage/budget accounting around the implemented capability and integration profiles.

## Reference provenance

The [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
informed lifecycle/image behavior. [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
informed the composition-root, provider-plugin, ingress, identity/credential, execution, delivery,
and durable-mailbox boundaries. Neither codebase is vendored; attribution is in
[`NOTICE`](../NOTICE).
