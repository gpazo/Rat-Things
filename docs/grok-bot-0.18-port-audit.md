# Grok Bot 0.18 product-parity and port audit

Date: 2026-08-24

## Scope and provenance

This is a product-parity comparison between Rat Things and the local Grok Bot 0.18 source dump at
`../grok-bot-0.18-reconstructed`. Grok Bot is neither Rat's upstream nor a repository Rat intends to
merge. Its recovered renderer and host code now provide implementation evidence for a product that
was previously evaluated mostly through documentation.

The goal is to reach the useful Grok Bot product behaviors with Rat's safer server-side design:
keep the existing Rat CLI, owner-derived API identity, durable Run model, and Lambda MicroVM
execution backend; do not reproduce Grok's desktop account model, local daemon, or Electron bridge.
Frontend work is valuable as an operator and test surface, not as a new execution architecture.

The dump's provenance file says that an upstream source-code license is not implied. The local
console added in this intake therefore reimplements the narrow Rat experience against Rat contracts
instead of importing the recovered renderer or its Electron/RPC bridge. Redistribution of recovered
assets or implementation text still needs an independent rights review.

## Protected Rat Things invariants

Every recommendation below preserves these local contracts:

- `src/domain` remains AWS-independent and owns run state transitions.
- provider ingress, agent execution, and result delivery remain separate stages;
- owner, actor, source, destination, and credential subject remain distinct;
- API-derived identity owns a Run; callers cannot select another owner;
- credential values remain behind the broker and never enter Run requests, state, logs, task
  overrides, repository URLs, or model-visible dynamic-tool metadata;
- S3 body references remain owner-scoped, checksummed, and inaccessible without an owner check or
  a short-lived grant;
- run retries do not silently repeat a semantic operation that may already have caused an external
  side effect; and
- Lambda MicroVM remains the remote isolation boundary and only remote execution backend.

## Architecture comparison

The two products overlap at the level of failure modes, not deployment shape.

| Concern | Grok Bot reconstruction | Rat Things | Portability |
| --- | --- | --- | --- |
| Process supervision | Desktop coordinator supervises a local execution daemon using discovery files, exact process identity, generation tokens, heartbeats, serialized reconciliation, miss thresholds, quarantine, and a respawn ceiling | EventBridge/SQS/DynamoDB coordinate Lambda MicroVM Runs; workers heartbeat with an immutable execution generation and stale attachments are inspected and conditionally repaired | Ported at the state-machine level; filesystem/PID mechanics were not portable |
| Conversation durability | SQLite/blob graph with root recovery, transcript backfill, garbage collection, soft/hard size limits, and pending-entry repair | DynamoDB mailbox plus immutable S3 bodies/checkpoints and S3 Files workspace/Codex state | Medium; use bounded references and range summaries, not SQLite recovery code |
| Continuation | Explicit interrupted-response continuation, interrupted pending-tool reconstruction, and persisted goal state | Durable transcript replay plus best-effort native Codex thread resume | High for explicit handoff markers; medium for tool-call reconstruction |
| Tool output | Large MCP text is spilled to an agent-readable file with inline location metadata and a truncation fallback | Integration JSON is rejected above 128 KiB; browser media already writes to the artifact outbox | High after retention/redaction policy is decided |
| OAuth credentials | Loopback callback registry plus expiring credential renewal with leeway, bounded polling, backoff, immediate refresh, and redacted errors | Already-issued OAuth tokens are stored and brokered; hosted authorization/refresh is absent | High for lifecycle rules; loopback HTTP binding is desktop-only |
| Human intervention | Explicit browser/box handoff with one pending request and completion/cancel settlement | No mid-Run authorization decisions by design; the host fixes the envelope before launch and admitted browser actions are autonomous | Do not port a permission inbox; a future browser takeover would transfer interaction, not widen authority |
| Concurrent file tools | Abort-aware per-path locks and a fair exclusive lock | Codex owns ordinary filesystem tools; Rat only hosts browser/integration tools | Low until Rat hosts parallel file-mutating tools itself |
| Desktop secret storage | Trusted-window IPC guard plus OS-encrypted local store | AWS Secrets Manager, owner-scoped bindings, and a host-only credential broker | Do not port; Rat's server-side boundary is the correct one |

## Recovered frontend inventory

The editable renderer is a substantial React/TypeScript reconstruction rather than a single mock:
its closure manifest reports all 11 shipped feature routes, 20 recovered feature families, and no
unresolved imports in the clean renderer graph. The most relevant product surfaces are:

| Grok surface | Rat capability before this intake | Decision |
| --- | --- | --- |
| Conversation sidebar, transcript, composer, status, search | Thread submission existed, but there was no public conversation list or transcript read model | Port the product seam and a small Rat-native shell |
| Live activity, pending permissions, interrupt/steer | Owner-scoped Run events, generic input responses, interrupt, and steer exist; approval responses were removed by policy | Expose typed activity and ordinary input in the console; do not port Grok's permission prompts |
| Agents, group membership, shared rooms | No matching Rat public object; Rat owns durable conversations and reusable Things instead | Do not invent an Agent roster merely to match nouns |
| Automations/routines | Durable interval routines and Things exist, but no console pages | Good next UI slice after conversation hardening |
| Plugins/settings/account | Rat uses trusted manifests, host-owned OAuth/credentials, and deployment configuration | Build Rat-specific connection/grant pages; do not port desktop account/session state |
| Computer shell, VNC, teaching/rebuild | Rat has backend-neutral browser/computer capabilities inside isolated execution | Reuse only interaction ideas after a durable takeover contract exists |
| Attachments, rich cards, outline, find-in-chat, viewers | Durable artifacts exist; transcript card/viewer contracts do not | Add incrementally from typed Rat artifact metadata, not recovered renderer payloads |

The recovered production renderer talks to a transferred Electron `MessagePort` and a large desktop
preload contract. That bridge is the wrong portability boundary. Rat's matching boundary is its
authenticated OpenAPI control plane, with a loopback-only signing proxy for local browser testing.

## Intake decisions

Risk is scored with the parity judgement rules: protected boundary `+3`, auth/protocol/runtime
semantics `+3`, broad refactor `+2`, weak coverage `+2`, and packaging/config risk `+1`.

| Order | Evidence anchor | Decision | Status | Risk | Confidence | Validation |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | `source/host/extensions/session/session-projection.ts` and the general stored-state/view-state split | Independently implement a narrow public Run projection | ported | 3 | 0.97 | focused projection, control Lambda, OpenAPI contract, type, and architecture tests |
| 2 | `source/packages/chat-inference/middleware/continuation-injector-middleware.ts` plus conversation size-limit behavior | Make bounded replay omissions explicit and retain cumulative compaction evidence | ported | 3 | 0.93 | conversation coordinator/service, type, and architecture tests |
| 3 | recovered conversation sidebar/transcript/composer and coordinator client | Add an owner-scoped conversation list/detail API plus a Rat-native local console | ported and hardened | 6 | 0.95 | projection, service/store, cursor paging, typed activity, OpenAPI/Terraform, proxy, DOM, and viewport checks |
| 4 | `source/node-agent-coordinator/local-exec/supervisor.ts` and `local-exec/daemon-files.ts` | Independently implement generation-fenced active-Run heartbeat and reconciliation; do not copy PID/file mechanics | ported; live failure injection validated | 6 | 0.96 | generation, heartbeat, exact health probe, DynamoDB fencing, reconciliation, quarantine, cancellation, retry-safe dispatch, and live failure injection |
| 5 | `source/host/extensions/auth/credential-renewer.ts` and the OAuth callback registry/listener | Port lifecycle semantics into an AWS-hosted authorization-code/PKCE helper | manual follow-up | 6 | 0.86 | requires provider fixtures, replay/CSRF tests, rotation identity checks, and secret-leak scans |
| 6 | `source/packages/agent/tools/mcp/mcp-output-spill.ts` and `source/host/runner/large-output-spill.ts` | Spill oversized integration output only after a retention/redaction decision | blocked by policy choice | 6 | 0.74 | must prove provider data is bounded, owner-scoped, redacted as configured, and removed on failed turns |
| 7 | interrupted-tool reconstruction and pending-tool execution contracts | Persist enough tool-call identity to close interrupted calls without re-executing them | manual follow-up | 8 | 0.72 | requires durable event/request records and replacement-VM tests |
| 8 | conversation blob GC/root recovery and pending-entry sweeps | Reuse storage invariants, not approval semantics or implementation | reference only | 6 | 0.82 | Rat-specific S3/DynamoDB design required |
| 9 | file-operation locks, Electron secret store, renderer/session roster | No current port | skipped | 3 | 0.98 | deployment/product mismatch |

### Decision 1: public Run projection

Intent: separate the internal Run record from the owner-visible API representation.

Local implementation:

- `src/core/run-projection.ts` defines and builds the safe client contract;
- `src/lambdas/control.ts` applies it to submission, list, get, Thing/routine Run receipts, and
  cancellation responses;
- object-store bucket/key references, ownership/index keys, request hashes, provenance,
  conversation bindings, MicroVM IDs, and Codex thread IDs do not cross the API boundary;
- terminal previews, usage, safe Thing evidence, execution backend/start time, and artifact metadata
  with SHA-256 remain available; and
- full input/output/events/patch/file bytes remain available only through existing owner-checked
  artifact routes.

Rollback: revert the projection call and its OpenAPI/docs changes. That is mechanically easy but
would intentionally restore the documented disclosure risk.

### Decision 2: explicit replay handoff

Intent: prevent a replacement session from treating a silently truncated transcript as complete.

Local implementation:

- bounded replay states how many retained entries were omitted from the prompt;
- durable checkpoint metadata carries a cumulative count of already-compacted entries instead of
  resetting the count at every turn;
- existing metadata is preserved; and
- the prompt explicitly says not to invent omitted facts and to ask or inspect durable files when
  necessary.

This is not semantic summarization. It is the truthful handoff foundation on which a later summary
contract can be added.

Rollback: revert the prompt marker and cumulative counter. Stored checkpoints remain readable
because the metadata field was already optional JSON.

### Decision 3: conversation read model and testing console

Intent: make Rat's existing durable conversation behavior observable and testable without replacing
the CLI or execution backend.

Local implementation:

- new `GET /v1/conversations` and cursor-paged `GET /v1/conversations/{opaqueId}` routes provide
  owner-scoped summaries and durable user/assistant transcript windows;
- an owner-created DynamoDB index supports newest-first listing, while an opaque SHA-256 identifier
  addresses a conversation without disclosing provider routing identifiers;
- bounded first-message titles and newest-message previews are denormalized onto conversation
  metadata, so list rendering does not read S3;
- accepted user messages and completed assistant results transactionally create immutable transcript
  index entries, with chronological page hydration from checksummed S3 bodies;
- public attachments contain opaque content IDs rather than bucket/key coordinates;
- public projections omit owner/capability principals, S3 references, MicroVM IDs, Codex thread IDs,
  policy bindings, and checkpoint metadata other than the compaction count;
- API-created conversations expose only their caller-chosen thread key so the same owner can submit
  a continuation; provider conversations are read-only in this API console;
- raw App Server traffic is projected to typed product activity cards without exposing methods,
  parameters, commands, results, reasoning, or native thread/turn IDs;
- `npm run console:serve` starts a desktop testing shell with conversation list, paged transcript,
  composer, typed live Run activity, and interrupt control; and
- the console server binds to `127.0.0.1`, signs upstream requests with host AWS credentials, rejects
  foreign origins, and never forwards requests outside `/v1`.

The console is intentionally a small independent frontend. It uses the recovered product's useful
layout and interactions, not its Electron preload, desktop account state, coordinator RPC names, or
React component graph.

Migration note: conversations created before the owner index is deployed have no `ownerCreated`
attribute, title/preview metadata, or immutable transcript index entries. Later activity repairs the
owner index and list metadata through normal conditional writes. A deployment that must list old
inactive conversations or page beyond their current checkpoint needs a throttled one-time backfill.

## Remaining implementation slices

### Deferred: complementary conversation checkpoints

Live deployment `perf260824a` showed that the first durable turn reached `running` in 52.789
seconds, while continuation on the same suspended MicroVM reached `running` in 2.015 seconds. The
cold run hook spent 40.242 seconds mounting S3 Files and another 4.178 seconds preparing the first
conversation directory; the warm path spent 1 millisecond checking the existing mount and 108
milliseconds preparing state. Storage therefore accounted for 44.420 seconds, or 84% of the entire
cold time-to-running and 95% of the post-dispatch wait. Generic MicroVM prewarming is not the first
optimization target.

The dump provides a stronger persistence pattern in
`source/host/extensions/box-store-sync`: local box state is captured into content-addressed blobs,
committed through a versioned manifest, restored with bounded download concurrency and a byte
budget, and guarded by writer locks and hydration-complete markers. SQLite state is copied through
a verified snapshot rather than read while live, and small objects can be restored from packs.
Those invariants are portable even though Grok's desktop box lifecycle is not.

S3 Files remains Rat's primary durable workspace and Codex-state implementation. Do not bypass its
mount on new conversations or replace it with local-disk hydration merely to improve cold-start
latency. A future checkpoint feature may reuse the dump's content-addressed invariants as a
complementary verified backup/recovery layer:

1. Define a versioned conversation-state manifest containing relative path, SHA-256, byte size,
   mode, source generation, and a complete-hydration marker. Keep blobs under the existing
   owner/conversation-hashed S3 namespace.
2. On turn completion, snapshot live SQLite state to temporary files, hash and upload changed blobs,
   then conditionally commit the manifest under the current conversation lease/fencing token.
   Never publish a partial manifest or release the lease before the commit is durable.
3. Verify checkpoint digests and entry counts during recovery drills without changing the normal
   S3 Files mount/continuation path.
4. Start without Grok's pack-maintenance complexity. Measure real Rat state first; add small-file
   packs only if request count, rather than total bytes, dominates hydration.
5. Fault-inject VM termination between blob upload and manifest commit and prove S3 Files remains
   the authoritative rollback path.

Do not copy Grok's implementation text or desktop object-store protocol. Reimplement the manifest,
snapshot, fencing, and verified-hydration properties against Rat's ports and AWS ownership model.

### Priority 3: harden the conversation read model and console — substantially completed

This pass completed stable titles/previews, transcript cursor pagination, typed activity projection,
the older-message console control, and matching Playwright coverage. Remaining before calling the
console a supported product surface:

1. add a one-time, throttled backfill for pre-index conversation records;
2. settle interrupted dynamic tool calls durably without replaying consequential operations; and
3. add rich artifact cards/viewers and transcript search on top of the safe public contract.

### Priority 1: active-Run heartbeat and reconciliation

The supervisor invariants are now mapped to DynamoDB and Lambda MicroVMs:

1. Give every execution attachment an immutable generation token in addition to its MicroVM ID.
2. Add a conditional worker heartbeat that updates only when `status=running`, Run ID, MicroVM ID,
   and generation all match. An old/replaced worker must be unable to refresh a successor.
3. Keep heartbeat state out of semantic `updatedAt`, or the existing status GSI will conflate work
   progress with state transitions. Add a dedicated liveness attribute/index.
4. Reconcile serially per Run. Describe the attached backend after two missed heartbeat windows to
   avoid a one-observation false positive.
5. If the exact generation is live, do nothing. If it is terminal or absent, mark the Run failed
   with an explicit retryable infrastructure error; do not automatically create a new semantic Run.
6. For `cancelling`, terminate the exact generation and conditionally finalize `cancelled`.
7. Quarantine conflicting observations instead of terminating an execution whose identity cannot
   be proven, and cap repeated recovery attempts.

This closes the roadmap's attached-execution gap without weakening side-effect safety. Live AWS
deployment `hb260824a` exercised the complete failure path: the runner refreshed `heartbeatAt`
without changing semantic `updatedAt`, a stale generation could not refresh the Run, the exact
attached MicroVM was terminated, and an explicit reconciler invocation conditionally produced the
retryable `execution_lost` terminal state. The 227-resource stack then destroyed cleanly and passed
the tagged-resource audit.

### Priority 4: hosted OAuth/PKCE and refresh

Keep the provider-specific browser redirect outside the agent and model:

- store a one-time, high-entropy state digest, PKCE verifier reference, owner, connection intent,
  exact redirect URI, and TTL in a dedicated authorization-attempt record;
- consume state with a conditional write before exchanging the code;
- verify the returned provider identity before creating or rotating a connection;
- store access/refresh values only in the credential vault, with expiry metadata outside the Run;
- refresh before expiry with a leeway, minimum/maximum interval, exponential backoff, and one
  coalesced immediate retry after a classified `401`/`invalid_token` response;
- redact URLs, paths, long identifiers, response bodies, and tokens from renewal diagnostics; and
- never reuse the dump's localhost listener in the AWS service. Use the authenticated API Gateway
  callback origin configured for the deployment.

### Priority 5: large integration-result spill

The current 128 KiB rejection is safe but unfriendly. A Rat-native version should:

- keep a small inline threshold and a separate hard provider-result limit;
- write the complete bounded JSON to a generated path below
  `.rat-things/artifacts/tool-output/` only after output policy/redaction;
- return path, byte count, line count, and SHA-256 to the model instead of the full payload;
- fail closed with a clear non-retry instruction if the file cannot be written;
- let successful artifact-catalog commit make the result durable, while a failed turn cannot mutate
  the committed catalog; and
- explicitly decide whether connector results should be downloadable user artifacts. If not, use a
  separate encrypted scratch namespace with a deletion/GC contract.

Do not raise the existing limit without adding this retention boundary; that merely moves the
failure into model context or App Server transport.

### Priority 2: durable interrupted-tool settlement

Persist a minimal host-side contract for each live server request: request ID, method/tool identity,
argument digest, admitted tool set/version, started time, status, and bounded preview. On
interruption or replacement, append a synthetic terminal error for the exact pending call so the
model never sees an unmatched tool call. Never replay a consequential call automatically.

Do not add a durable approval inbox. Rat Things deliberately fixes authorization before launch.
This tool-call ledger should follow active-Run liveness because request ownership depends on knowing
which execution generation is authoritative; it exists to close protocol state safely, not to pause
for a permission decision.

### Priority 6: semantic memory, fallback summaries, and explicit agent handoff

Native Codex context compaction already persists inside the conversation's S3-backed `CODEX_HOME`.
A live local regression forces compaction, terminates App Server, resumes the exact thread from a
fresh process, and observes both the pre-compaction marker and `contextCompaction`. Codex's optional
`memories` feature is disabled, however, and the per-conversation/per-turn process model would not
by itself provide Grok-style cross-conversation semantic memory.

Define Rat-native owner, Thing, and conversation memory scopes with immutable evidence, explicit
versus generated origins, correction/tombstone behavior, relevance and prompt budgets, provenance,
and conditional synthesis outside the per-turn App Server lifetime. Continue to let Codex own its
native context compaction.

Do not port SQLite blob GC. Rat already has immutable bodies, bounded coordination records, and
bucket lifecycle. As a complementary replacement-replay fallback, add a Rat-specific checkpoint
revision containing:

- a summary artifact;
- the exact first/last event or message IDs covered;
- source digests and summarizer model/version;
- unresolved decisions, active goals, referenced durable files, and pending human requests; and
- a retained recent transcript tail.

Commit the summary only with a conditional comparison against the context reference it summarizes.
That makes compaction auditable and prevents a late summarizer from overwriting newer context.

## Explicit non-ports

- Do not replace Secrets Manager with the reconstructed Electron encrypted JSON store.
- Do not add a local daemon/PID discovery protocol to the MicroVM backend.
- Do not import Grok's generated protobufs, renderer bridge contracts, goal engine, subagent runtime,
  or desktop roster merely to claim product parity.
- Do not add host-level file locks while Codex remains the owner of file tools; add them only if Rat
  later executes parallel host-side file mutations.
- Do not automatically resume or retry a pending integration write after an interruption.

## Validation record

Focused validation completed during intake:

- `npx vitest run tests/core/run-projection.test.ts tests/lambdas/control.test.ts`
- `npx vitest run tests/spec/contracts.test.ts tests/core/conversation-projection.test.ts`
- `npx vitest run tests/conversation/coordinator.test.ts tests/conversation/service.test.ts`
- `npx vitest run tests/adapters/dynamo-conversation-store.test.ts`
- `npx vitest run tests/core/agent-activity-projection.test.ts`
- `npm run test:e2e:codex-app-server`
- `npm run test:e2e:console`
- `npm run typecheck`
- `npm run architecture:check`
- local console proxy smoke checks for static security headers, list/detail forwarding, local owner
  injection, host-side credential isolation, and foreign-origin rejection;
- desktop screenshots at 1440×900 and the compact 760×700 layout.

Repository-wide validation also completed successfully with `npm run check`:

- architecture and TypeScript checks passed;
- all 316 enabled tests passed across 75 files, with 20 intentional opt-in tests skipped;
- all 13 Lambda bundles packaged and smoke-loaded;
- the 26-page documentation site built;
- Terraform formatting checks passed; and
- the root, LocalStack, and live-AWS Terraform configurations initialized and validated.

Fresh disposable live-AWS deployment `rm260825a` then passed the focused two-turn console journey in
51.3 seconds. It validated stable title/preview metadata, four ordered durable transcript entries,
opaque public identifiers, and same-MicroVM continuation against deployed DynamoDB, S3, S3 Files,
API Gateway, and Lambda MicroVM resources. That deployment used the deterministic mock runner, so
typed App Server activity remains covered by projection tests and the deterministic browser fixture,
while native compaction is covered by the separate real-Codex App Server regression. Teardown
terminated both MicroVMs, destroyed all 226 resources, and passed the tag audit.

At the time of this intake, the gate emitted a Node 20 future-support notice from the AWS SDK and
Terraform secondary-index key-schema deprecation warnings. Both were removed on 2026-08-26 by
raising the supported toolchain and bundle target to Node 22 and migrating secondary indexes to
`key_schema` blocks; the historical validation result above is otherwise unchanged.

## End-of-run summary

- Rat ref: `main`; this intake remains an uncommitted working-tree change for review.
- Grok evidence snapshot: local 0.18 reconstructed source and editable renderer at `a9f633e`.
- Evidence slices reviewed: host supervision, session projection, continuation, credential renewal,
  large-output spill, interrupted tools, conversation storage, and recovered renderer closure.
- Outcomes: 5 implemented slices, 3 manual backend follow-ups, 1 policy-blocked choice, 1
  reference-only storage comparison, and 1 explicit non-port group.
- Remaining queue: historical transcript backfill, hosted OAuth/refresh, large tool-output retention
  policy, durable interrupted-tool settlement, semantic memory/fallback summaries, and Rat-specific
  Things/routines/integrations console pages.
