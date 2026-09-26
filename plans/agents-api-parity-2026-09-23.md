# Agents API parity continuation — September 23

> September 25 closeout: see [the bounded remaining-work list](agents-api-closeout-2026-09-25.md).
> The retirement fix passed live; this cycle is closed at the user's request. Full parity remains unclaimed.


## Current status — 2026-09-24

The repository-wide check is green: architecture and generated-contract checks,
TypeScript, MicroVM syntax, 1,074 local tests (46 opt-in skips), ARM64 package
creation and Lambda smoke tests, site generation, and all Terraform format and
validation checks pass. The check runs tests without the packaging-only runtime
artifact override, then packages the exact CI-built ARM64 artifact.

The isolated AWS deployment `ag260913a` has passing live evidence for the direct
HTTP transport and large binary Files, managed Session continuation, workflow
resources, scheduler delivery, credential proxy/rotation/IAM isolation, webhook
retry/fan-out, MCP reconnect/revocation, and checkpoint-loss/replacement-worker
recovery. The deployed relay and scheduler fixes are now pinned to the exact
image digests recorded in the [storage acceptance report](agents-api-live-storage-2026-09-24.md).
The release input file now selects the subsequent typed-content candidate;
earlier proofs do not certify that newer image automatically.

Parity is still open. Follow-up diagnostics identified shared-filesystem SQLite
contention and confirmed aborted DynamoDB transactions that incorrectly stopped
the Session journal. Commit `50f7a44` keeps SQLite indexes local while preserving
durable native journals, and routes confirmed transaction contention through the
existing revision-checked retry. Unknown or ambiguous failures are not replayed.
The exact ARM64 worker passes 369 strict native tests and the worker isolation,
browser, network and recording canary. A fresh SQLite directory can recover the
same native thread from durable journals without new inference.

The storage candidate was deployed through the original Terraform state. Both ECS
services are healthy; new workers use launch-template version 9 with the pinned
worker digest. Deployed limits 1 and 6 each pass overflow rejection, three
interruption/follow-up cycles and final child completion. Cancellation/SSE
reconnection and replacement-worker recovery with and without a hosted sandbox
also pass. The hosted missing-checkpoint case passes too: the replacement starts
from saved public history, preserves the conversation marker and saved artifact,
and reports a fresh workspace with exactly one reset event.

The six-child proof exposed a six-minute FIFO delay after a confirmed rejected
storage write. Commit `48de5d4` distinguishes that storage error from generic
public 409 conflicts and schedules a five-second retry. Its repository check
passes; only the outbox Lambda changed in the reviewed follow-up deployment.
A fresh six-child proof passed against that correction in 208 seconds (the
earlier passing proof took 542 seconds with FIFO contention delays). No running
or pending proof worker remained after cleanup.

Commit `fcde56d` corrects collaboration call content from native encryption
metadata. Its typed-content and public MCP proofs pass. Provider tests exposed
late selection of the Bedrock catalog and null optional web-search fields;
`c2c6e34` corrects both. Its full check and CI pass. Worker template version 11
uses the exact accepted digest; API task 19 and relay task 16 are healthy.
All direct/programmatic/deferred function proofs, web search with cleanup, both
MCP origins, and capacities 1/6 pass against that image. See the storage report
for the first web-search cleanup conflict and its explicit resolution.

The next file-boundary pass reproduced a stack overflow on a valid 5 MiB inline
upload. The base64 validator correction (`0682e6c`) passes full checks and 404
strict ARM64 native cases. Local artifact capture
passes exact 200 MiB/500 MiB limits, empty files and mutation rejection. The exact deployed image also passed the 570-second live boundary proof:
50 inputs, 50 MiB Files API copy, 500 MiB downloaded and hash-verified artifacts,
and artifact deletion preserving its workspace file. No proof worker remained.
Broader Item/event, limit, initialization-failure cleanup and obsolete-code rows
remain open. Do not claim 100% compatibility until every ledger row has passing
evidence.

Starting point: `main` at `3a3d800`. Work branch:
`codex/agents-parity-completion`. All production infrastructure, harness state,
and execution remain in the operator's AWS account. The paused soak heartbeat
remains paused. The completed September soak validates its pinned images only.

## Earlier cycle record

The sections below retain the earlier implementation and validation sequence.
Statements about pending builds or deployments describe those earlier candidates;
the current status above and conformance ledger take precedence.

## Contract changes

The SDK was advanced from `openai@7.15.0` to `7.23.0`, with regenerated schemas
and OpenAPI definitions. The route inventory did not change. Current guides:

- [Session management](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage)
- [Vaults](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults)
- [Hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)

Implemented locally:

- Session updates merge only model, reasoning effort, and service tier. Omitted
  fields stay unchanged; nullable effort selects the new model's default and
  nullable tier resets to `auto`. Saved Agents remain unchanged. Each accepted
  Turn snapshots these settings before dispatch, including reuse of a running
  harness. Explicit native default-mode settings reset a previously selected
  effort when the public value resolves to null.
- Nullable list limits are accepted through both direct service calls and SDK
  HTTP encoding. Artifact pagination also accepts nullable `after`.
- Vault environment-variable credential CRUD validates names, values and exact
  host restrictions, redacts secret values, preserves immutable destination
  configuration across rotation, and excludes these credentials from MCP auth.
  Session snapshots use durable reservation/adoption/cleanup and remain stable
  across Vault rotation. A root-owned TLS proxy supplies exact-host HTTPS header
  substitution on ports 443/8443, including WebSocket upgrades, with DNS pinning,
  private-address denial and CONNECT/Host/SNI binding. Sandbox setup, normal
  commands and environment MCP receive placeholders and public CA configuration.
  Native enabled/restricted network command fixtures pass locally; deployed
  Secrets Manager/IAM, guest-UID isolation and worker image validation remain.

The native request fixture exposed an existing routing mismatch: stock Codex
silently omits `flex`, `auto`, and `default` in some requests, and translates
`fast` to `priority`. The `api-model-settings.patch` preserves explicit Agents
API routing choices through configuration and request construction. The model
provider remains responsible for rejecting unsupported choices. The patch has
not yet passed a rebuilt native runtime acceptance run. The strict fixture must
pass against the packaged binary before deployment or a parity claim.

## Validation and deployment

- Baseline `npm run check` passed before SDK changes.
- Focused service, execution and adapter checks passed: 107 tests.
- The first complete run after changes had 957 passing tests, 14 opt-in skips,
  and the new native service-tier assertion failed as described above.
- The strict native settings test also confirmed reasoning-effort reset on the
  stock runtime; its routing assertions remain an explicit acceptance gate.
- With that fixture reserved for `CODEX_REQUIRE_PARITY=true` and the patched
  binary, ordinary checks pass 957 tests with 15 opt-in skips. Architecture,
  generated contracts, TypeScript and MicroVM syntax checks pass. Source
  preparation verifies that all pinned patches apply together. Packaging and
  strict native acceptance still require the new exported runtime.
- Local Docker exhausted the workstation disk while preparing native source
  inspection. Generated output, duplicate provider downloads and superseded
  task images were cleaned; Docker was recovered. The existing ARM64 CI job
  will build the patched runtime on the draft PR. Terraform state and deployment
  evidence were retained.

Ignored evidence is under `.aws-e2e/ag260913a/parity-20260923/`.
The original state remains `.aws-e2e/ag260913a/terraform.tfstate` with lineage
`be69a19a-2f46-d753-8dc0-0884b98a7269`. No AWS deployment was changed in this cycle.

The credential implementation passes 981 ordinary tests (15 opt-in skips).
`npm run check` reaches packaging, which correctly rejects the old exported
runtime because it lacks the newly pinned settings patch. Draft PR #1 builds
the updated artifact in ARM64 CI; exact native-image acceptance is still pending.

Hosted replacement now has a private sandbox generation and an atomic reset
counter/event. Repeated readiness and lost transaction acknowledgements retain
the same counter. Unexpected worker/native loss leaves a disconnected sandbox
eligible for replacement on the next Turn; explicit expiry and deletion remain
terminal. Replacement clears old workspace contents without removing bind
mounts, reapplies declared inputs, and retains conversation checkpoints and saved
artifacts. The AWS worker-loss canary now requires the reset event, a fresh
workspace, and preserved conversation. It has not yet run against these changes.
The reset batch passes 985 ordinary tests (15 opt-in skips); full checks again
stop only at the expected old-runtime packaging gate.

Public Turn errors now preserve typed provider failures with fixed safe messages.
Native context, quota and policy fixture failures pass; credit-balance and HTTP
error categories require the new `api-turn-errors.patch`, which preserves the
typed category through the native protocol. All four pinned patches apply
together and native formatting passes. The ordinary suite passes 1,014 tests
with 20 opt-in skips, including five acceptance cases reserved for the rebuilt
binary. Native compilation, strict error acceptance and packaging remain open.

The obsolete control IAM candidates are removed after real composition and
Terraform graph checks. Schedule administration has no delivery/Scheduler
effects; the outbox and notifier retain those grants. Control Run deletion and
integration Update permissions are removed while OAuth/cursor deletion remains.
Three infrastructure scenarios and 1,015 ordinary tests pass (20 opt-in skips).
The exact deployed IAM plan and canaries still await packaging.

The hosted reset fence was also checked against dispatch: a semantic Run has one
immutable execution generation, and lost attached executions are not restarted
under the same Run ID. Replacement claims a new Run, so existing Run-ID fences
reject superseded readiness/status and journal writes.

The native recovery fixture now supplies an absent checkpoint ID instead of
starting a new thread directly. It passes locally, preserving saved tool context
without replay and completing two subsequent Turns. New opt-in AWS cases cover
the same missing-checkpoint fallback after exact-worker termination, hosted
credential substitution/rotation/guest isolation/secret retirement, and webhook
retry/fanout through the existing deployment-owned fixtures. Those live cases
are prepared, not yet executed. The ordinary check passes 1,015 tests with 23
opt-in skips and reaches the same native-artifact packaging gate.

The error audit was expanded to HTTP context/quota failures and SSE server,
timeout and budget categories. Typed response codes take precedence over generic
transport status. Seven native error fixtures pass on the current local binary;
sixteen require the expanded native patch. The ordinary suite passes 1,019 tests
with 34 opt-in skips; packaging still rejects the old runtime. The superseded
four-patch CI build was cancelled before restarting with this complete correction.
CI now saves a completed compilation before later acceptance checks so failures
in those checks do not discard an otherwise reusable, identity-checked artifact.

The completed ARM64 CI candidate now passes repository, infrastructure, relay,
MicroVM, native-image, site, packaging and artifact-provenance checks. The local
MCP bridge adds Streamable HTTP response resumption, notification cursors, retry
hints and expired-session reinitialization without replaying tool POSTs. A
deployment-owned MCP fixture and opt-in OAuth/revocation canary cover the real
service-origin Vault path; they await rollout of this exact candidate.

## Remaining priority order

1. Resolve automatic worker retirement after initialization failure. The deployed
   file-boundary/hash proof now passes on `0682e6c`; provider configuration and
   affected multi-agent/MCP live proofs pass on `c2c6e34`.
2. Finish artifact/file boundaries, Item/event causal order, defaults, errors and
   limits in the behavior ledger. Typed encrypted collaboration content now has
   native and deployed sender/recipient evidence; this does not close every Item.
3. Complete the obsolete-code and caller/grant inventory. The deployed control
   role has lost obsolete scheduler/delivery grants while the outbox retains them;
   remove only proven-obsolete callers and preserve retained data.
4. Rerun affected local/image/live gates for further fixes. Claim parity only when
   every public behavior row has passing evidence.

Hosted reset is a contract change: the new event retains the environment ID and
conversation, increments `reset_count`, and loses previous sandbox files and
processes. The older terminal-expiry assumption and tests need review against
that behavior; the generated event union alone is not implementation evidence.
