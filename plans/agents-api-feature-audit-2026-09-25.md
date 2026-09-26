# Agents API feature audit — September 25, 2026

Status-wording resolution (September 26): the current official
[Environment retrieval reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/environments/methods/retrieve)
lists `pending` and uses it in its `openai_hosted` response example, agreeing with
`openai@7.23.0` and Rat Things. The hosted guide's `provisioning` wording is a
guide/reference inconsistency, not a missing Rat Things status. Keep `pending`
on the wire and `agent.session.environment.pending` in the stream. The client
guidance is now explicit in `docs/agents-api.md`; this audit question is closed.
This conclusion compares the published contract and implementation, not a new
black-box observation of OpenAI's hosted service.

Current follow-up: [bounded expiry/model/scope and behavior closeout](agents-api-closeout-next.md). The findings below are the earlier baseline; current acceptance and remaining release gates are in that follow-up.


Implementation follow-up: [OTLP export and Session update validation](agents-api-traces-2026-09-25.md)
records the subsequent priority-1 implementation and checks. The comparison below
remains the pre-implementation audit baseline.

Baseline: repository `33461f3`, branch `codex/agents-parity-completion`; deployed application `a766b7a`, as recorded in the migration closeout. This is a documentation and implementation audit, not a new deployment or live test run. It supersedes older status prose for the findings below, without replacing the underlying evidence.

## Finding

Rat Things implements the major Agents API primitives, but current documentation exposes at least two concrete gaps: session trace export and model-capability validation on Session updates. Several implemented behaviors still lack complete acceptance evidence. An unqualified “100% parity” claim is therefore not supported.

The route inventory contains 58 routes generated from OpenAI SDK 7.23.0. That is coverage of a pinned SDK surface, not proof of coverage of today's documentation: the documented traces endpoint is absent from both that inventory and our router.

The intended contract remains an AWS-owned implementation: backend, harness, session storage, credentials and workers stay in our account. OpenAI's own `self_hosted` mode moves only sandbox execution to the customer; it does not move OpenAI's harness or session service. See [architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture). Matching public behavior does not require transferring our infrastructure to OpenAI.

## Side-by-side comparison

“Implemented” means code exists and relevant tests/evidence were found; it does not certify every possible input. “Live” refers to recorded AWS proofs, sometimes on earlier images. Only the final release gate can establish acceptance against one exact release.

| Feature / documentation | Documented contract | Rat Things implementation and evidence | Remaining work for parity |
| --- | --- | --- | --- |
| [Agents and configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration) | Saved or inline Agents; Session snapshots; replacement/default/reset semantics. | Implemented in `src/domain/agent-configuration.ts` and Agent/Session services; contract and workflow tests. | Finish mapping defaults, nulls, invalid combinations and errors to the behavior ledger; no newly identified missing CRUD primitive. |
| Session model updates, same configuration guide | Partial updates; active Turns keep their settings; resulting settings must be supported by the selected model. | `src/core/session-planning.ts:46` merges settings and validates model string length; `session-service.ts:151` persists without a capability check. | **Confirmed implementation gap:** validate the resolved model/effort/tier combination before persisting; reject unsupported combinations and leave the Session unchanged. |
| [Session lifecycle](https://developers.openai.com/api/docs/guides/agents-api/sessions) and [management](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage) | Create, continue, steer, cancel, retrieve/list and delete; durable Turns and Items. | Implemented; AWS workflow, continuation, cancellation and recovery evidence. | Close remaining documented error and pagination cases; preserve distinction between Session status, Turn failure and individual tool failure. |
| [Events and Items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events) | Live stream plus durable Items; reconnect using saved history rather than assuming historical SSE replay. | Streaming/reconnect and saved Item projection implemented and exercised live. | **Verification gap:** remaining image, nested attribution, restored-history and compaction Item/event variants in the existing ledger. |
| [Function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions) | Pending required actions, correlated tool results, errors, deferred loading and programmatic calling. | Direct, deferred and programmatic provider proofs passed on an earlier release; durable result reconciliation is implemented. | Carry exact proof references into acceptance; rerun affected cases only if implementation changes. |
| [Web search](https://developers.openai.com/api/docs/guides/agents-api/tools/web-search) | Live/cached/disabled modes; context size, domain filters and location. | Configuration and native translation implemented; live provider search proof exists. | Complete defaults/filter/error comparisons; a live search success alone does not prove every option. |
| [MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp) | Service/environment origin; HTTP/stdio; allowlists, required startup, scoped credential rules. | Implemented; real public MCP, reconnect and OAuth revocation proofs recorded. | Finish the configuration/error matrix, including optional versus required failures and transport/origin restrictions. |
| [Plugins and skills](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins) | Packaged capabilities, manifest/path rules, Session loading and environment MCP integration. | Skill service, package handling and Files/Skills tests exist. | Complete package boundary and inheritance assertions; do not infer full parity solely from endpoint presence. |
| [Vaults](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults) | Bearer, OAuth and environment credentials; matching, rotation and constrained secret injection. | Vault/OAuth services and environment credential proxy implemented; live placeholder, rotation and revocation evidence. | Finish ambiguity, refresh-expiry, host/port and collision cases. Distinguish deleting our credential from revoking a token at its provider. |
| [Environment choices](https://developers.openai.com/api/docs/guides/agents-api/architecture) | No environment, managed sandbox, or separately hosted executor. | Public configurations map to our AWS harness and execution paths. | **Intentional operator difference:** document AWS ownership explicitly. Do not describe our managed mode as compute operated by OpenAI. |
| [Managed sandbox setup](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted) | Workspace, packages, ordered setup, template configuration and failed setup preventing execution. | Implemented; latest release passed deliberate setup failure and automatic worker retirement. | Check remaining setup/template boundary rows. Docs say `provisioning`, while pinned SDK uses `pending`: resolve the documentation/type discrepancy before declaring a bug. |
| Managed sandbox expiry, same guide | After activity and keep-alives stop for an hour, a sandbox can be removed; stream closure alone does not cancel work. | Connected keep-alives and worker cleanup exist. Runtime idle timeout is optional and no caller supplies it; this does not itself establish the documented inactivity policy. | **Unverified policy:** inspect host-level expiry and demonstrate behavior when both activity and keep-alives stop. Do not substitute “one hour after Turn completion.” |
| [Self-hosted executor](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) and [lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle) | Outbound connection, connection deadline, reconnect and executor ownership separate from session service. | Environment relay, restricted tokens, leases and five-minute launch deadline implemented; reconnect/replacement proofs exist. | Finish late connection, disconnect and ownership/error comparisons. Session deletion must not imply terminating externally owned compute. |
| [Sandbox security](https://developers.openai.com/api/docs/guides/agents-api/environments/security) | Network modes and exact-host restrictions; protect credentials and privileged host operations. | AWS isolation, non-root agent process, network enforcement and credential broker implemented. | Verify documented boundary cases; keep AWS IAM and fixed capability envelope as our enforcement mechanisms. |
| [Files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files) | Creation input limits, file operations and immutable published artifacts; deleting artifacts does not delete workspace files. | Implemented. Live boundary proof covered 50 inputs, 50 MiB file copy, 200 MiB individual artifacts and 500 MiB aggregate downloads with hashes; workspace preservation passed. | No new missing feature identified. Retain that evidence and cover only remaining path/error variants. |
| [Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent) | Create/message/wait/interrupt; default six children; attribution and shared workspace. | Implemented. Latest capacity-one proof passed identity preservation, overflow and repeated interruptions; capacity six passed on earlier images. | Latest capacity-six proof needs one corrected prompt using the native child name, retaining public-ID assertions. The incomplete run is **not evidence of a production capacity bug**. |
| [Usage and observability](https://developers.openai.com/api/docs/guides/agents-api/observability) | Nullable, potentially late usage; per-agent attribution without counting descendants twice. | Usage projection, response deduplication and aggregation implemented and tested. | Complete forced-compaction and descendant attribution evidence; do not equate best-effort usage with final provider billing. |
| [Tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing) | Paginated `GET /v1/agents/sessions/{session_id}/traces` with OTLP trace payloads, agent/generation/tool hierarchy and access controls. | **Missing.** `src/lambdas/agents-router.ts:126` has no traces branch; requests fall through to 404. No public trace persistence/export implementation was found. | Capture and persist spans in AWS, expose the paginated OTLP projection, enforce access and secret filtering, and test hierarchy, outcomes and eventual availability. CloudWatch logs alone do not satisfy the endpoint. |
| [Session webhooks](https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks) | Session notifications, including action-required lifecycle signals. | Durable outbox and webhook delivery implemented; retry/fanout proofs recorded. | Complete payload/event matching and connection-start ordering evidence. |
| Authentication and permissions | OpenAI project/organization keys and operation permissions; trace read permissions described in the tracing guide. | IAM-derived ownership and short-lived Rat Things bearer tokens. `src/core/api-token-service.ts:5` stores owner, audience and expiry, not equivalent operation scopes. | **Intentional authentication difference, missing equivalence if claimed:** retain AWS credentials but either implement corresponding scoped permissions or explicitly exclude OpenAI account/key semantics from the contract. |
| Model availability | A configured model must be available and support the requested settings. | Provider routing and model settings exist; selected models have live evidence. | Publish/test the supported model matrix. API schema compatibility does not establish all OpenAI model names, service tiers or provider behavior are interchangeable. |

## Finite completion order

1. Implement trace export and model-setting compatibility validation. These are concrete feature/behavior gaps, not another round of exploratory testing.
2. Resolve the hosted inactivity policy, supported model matrix and operation-permission contract. Record explicit differences instead of calling them parity.
3. Close the existing Item/event/default/error ledger with code and test references. Add tests only for uncovered documented requirements; avoid inventing additional migration scope.
4. Correct and rerun the capacity-six proof once. Separately diagnose the exploratory native close/resume fixture before deciding whether it reveals a product defect; the advertised multi-agent guide's create/message/wait/interrupt contract does not alone require that extra native fixture.
5. Pin one final release, run required checks and affected AWS proofs, and review/merge. Acceptance requires every in-scope documented behavior to have evidence or an explicit exception; a test count or SDK route count is insufficient.

## Obsolete implementation cleanup

The old public Run/conversation/Thing/Routine API, coordinator and unused grants were already removed. Remaining cleanup is old deployment data/bindings, fixtures whose replacements are proven, historical demo media and optional native build-size optimization. Keep private Run execution machinery, active integration consumers and physical resource names still serving canonical Sessions. These are not additional Agents API features and should not delay functional acceptance unless a concrete dependency or security issue is found.

## Evidence and limits

- [Latest closeout](agents-api-closeout-2026-09-25.md): deployed release, accepted checks and unresolved investigations.
- [Detailed AWS evidence](agents-api-live-storage-2026-09-24.md): successful and failed attempts, release attribution and cleanup.
- [Conformance ledger](agents-api-conformance.md) and [Item/event audit](agents-api-item-event-audit-2026-09-14.md): remaining granular comparisons. Historical narrative in these files must not override the latest closeout.
- [Removal inventory](obsolete-implementation-removal.md) and [caller audit](obsolete-caller-audit-2026-09-14.md).
- Primary code: `src/lambdas/agents-router.ts`, `src/core/session-service.ts`, `src/core/session-planning.ts`, `src/core/environment-service.ts`, `src/runner/session-runtime.ts`, `src/core/api-token-service.ts`.
- Relevant tests: `tests/agents/contract-boundaries.test.ts`, `tests/agents/native-item-events.test.ts`, `tests/agents/files-and-skills.test.ts`, `tests/agents/vaults-and-templates.test.ts`, `tests/agents/vault-oauth.test.ts`, plus `tests/aws/` workflow, recovery, provider, MCP, credentials, files, webhook, multi-agent and retirement suites.

The audit consulted the 21 current Agents API guide pages linked from the overview, relevant SDK contracts and implementation, and existing acceptance records. It is not an exhaustive new black-box comparison against OpenAI's service. No new live tests or application changes were made for this report. Previously recorded full checks passed 1,093 tests with 47 opt-in skips; the accepted strict native suite passed 405 cases. These figures describe validation breadth, not a parity percentage.
