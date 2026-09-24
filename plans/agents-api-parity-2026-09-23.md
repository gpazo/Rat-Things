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
  Sandbox injection and trusted proxy substitution remain to be implemented.

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

## Remaining priority order

1. Build and test the native settings patch. Complete environment-variable
   credential snapshot/injection/proxy behavior and hosted reset semantics from
   the current SDK; audit the new credit-balance error mapping.
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
