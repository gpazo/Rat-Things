# Agents API parity continuation — September 23

Starting point: `main` at `3a3d800`. Work branch:
`codex/agents-parity-completion`. All production infrastructure, harness state,
and execution remain in the operator's AWS account. The paused soak heartbeat
remains paused. The completed September soak validates its pinned images only.

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

## Remaining priority order

1. Build and test the native settings and typed error patches. Complete environment-variable
   credential and hosted reset image/live acceptance; audit the new credit-balance
   error mapping and the other public Turn error categories.
2. Run repository, infrastructure, worker/relay/native image and LocalStack
   checks, then plan/apply the existing stack with its original Terraform state.
   Validate the exact deployed image digests.
3. Exercise native checkpoint loss, replacement-worker recovery, hosted reset
   file/process loss, and deployed multi-agent interruption/concurrency limits.
4. Finish provider, scheduler, credential/IAM, webhook retry, MCP reconnect,
   artifact/file boundary, Item/event and limit comparisons in the behavior ledger.
5. Complete the obsolete-code and caller/grant inventory. Remove only callers
   proven obsolete, preserving still-supported backends and retained data.
6. Claim parity only when every public behavior row has passing evidence.

Hosted reset is a contract change: the new event retains the environment ID and
conversation, increments `reset_count`, and loses previous sandbox files and
processes. The older terminal-expiry assumption and tests need review against
that behavior; the generated event union alone is not implementation evidence.
