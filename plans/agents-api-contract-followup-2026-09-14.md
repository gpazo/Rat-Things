# Agents API HTTP and artifact contract follow-up

This bounded local pass follows the
[parallel review](agents-api-parallel-review-2026-09-14.md). It changes no AWS
resources and does not update the deployment running the long soak. Full Agents
API parity remains open in the [conformance ledger](agents-api-conformance.md).

## Corrected behavior

The official [Agent list reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/methods/list)
and [Session list reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/list)
permit a nullable limit. The pinned `openai@7.15.0` SDK serializes a null query
value as `limit=`, although its inherited TypeScript cursor parameters omit null.
The HTTP boundary now normalizes that encoding to the default page size for
these two routes before generated-schema validation. Invalid numeric values,
whitespace, literal `null`, and repeated parameters still fail before storage
access. Other list routes retain their existing limit validation; their detailed
reference comparison remains open.

Agent read, update and delete now use the once-decoded resource ID already used
by the other resource routers. A valid escaped character no longer causes a
false not-found result. Malformed percent encoding produces a structured 400
instead of an internal error. Ownership checks and double-encoding behavior are
preserved. This is a concrete transport correction; the full upstream path/error
matrix has not been established by this pass.

The pinned SDK's `ArtifactListParams` documents `environment_id` as a filter and
`order` as creation-time/ID ordering, defaulting to descending. See the official
[artifact list reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/artifacts/methods/list).
Previously the service ignored the environment filter and concatenated root
artifacts before child artifacts without sorting. It now removes deleted and
nonmatching entries and orders a fresh array before cursor pagination. Both
directions therefore paginate consistently across root and child output. A null
environment filter retains all environments. The calculation does not mutate
execution snapshots or add storage effects.

## Verification and limits

Six initial HTTP regressions and both artifact ordering/filter regressions failed
before their fixes. The final targeted run passes 45 tests across list response
contracts, Session lifecycle and publication behavior. Coverage includes nullable
SDK query encoding, invalid/repeated parameters, escaped IDs, malformed escapes,
ownership, deletion, both artifact sort directions, pagination and immutable
input arrays.

The separate [usage audit](agents-api-usage-audit-2026-09-14.md) records the exact
response/compaction accounting correction and 46 passing strict targeted tests
against the patched native Codex binary.

Full `npm run check` passes: 914 tests, 14 opt-in skips, architecture and generated
contract checks, TypeScript, packaging, site build and all three Terraform
validations. The check used the patched native Codex binary and pinned Linux
ARM64 package. Evidence is retained in
`.aws-e2e/ag260913a/contract-usage-followup-check.log`. `git diff --check` also
passes. These changes remain uncommitted and undeployed at this validation point.

The exhaustive field/error/default/limit and Item/event comparisons, live recovery and
multi-agent/tool/provider cases, and deployment cleanup inventory remain open.
No new deployment or soak result is implied by local checks.
