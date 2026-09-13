# Obsolete implementation removal handoff

The public execution contract is the OpenAI Agents API. Rat Things owns the AWS
backend, harness, storage, execution, identity and capability enforcement. The
former public API has no compatibility requirement. Preserve useful integration
capabilities while replacing their dependencies on that API.

The user authorizes code work and local verification, followed by live AWS
end-to-end testing after parity. The conformance ledger defines that gate.
Retained table deletion and queue purges are separate from disposable test-resource
cleanup. Preserve existing deployment data until its retention and disposition
are explicit.
Use `.agents/skills/functional-programming/SKILL.md`: calculations operate on
supplied values; services perform reads, conditional writes and external effects.

## Completed in this migration

- The console and canonical CLI groups use Agents, Sessions, Turns, Items,
  environments, environment templates and Vaults with upstream SDK resource types.
- Session execution calls private `RunService` directly. It bypasses
  `RunSubmissionService`, conversation submission and the old mailbox coordinator.
- Standard workers omit the legacy artifact catalog, share-request workflow,
  automatic publication, workspace patches and legacy Run integration-tool injection.
  Managed Session artifacts snapshot `/workspace/outputs` instead.
- Signed GitHub, GitLab, Slack and Teams ingress resolves an owned Agent binding
  and commits a Session input receipt. Signature validation, identity separation,
  HTTPS repository allowlists and occurrence deduplication remain in place.
  Slack/Teams retain per-sender thread continuity; repository occurrences have
  distinct Sessions so one event cannot change another workspace's checkout ref.
- `SessionIntegrationService` submits input in receipt order, using canonical
  Session creation and events. Preparation snapshots survive lost acknowledgements;
  a deleted Session cannot be resurrected by retrying its first input.
- Provider delivery uses saved terminal root Turns and a separate FIFO group from
  execution. Private harness exit does not send another notification. Delivery
  fences retain uncertain outcomes rather than repeating an ambiguous external
  write; confirmed retryable rejections can be attempted again.
- `ScheduleService` and `EventBridgeSessionScheduler` replace both Thing schedules
  and interval Routines. Schedules reference an Agent/environment, preserve input
  templating and overlap policy, reserve occurrences before asynchronous acceptance,
  and synchronize AWS triggers through the durable outbox.
- Removed Thing and Routine domain models, validators, planners, services, DynamoDB
  stores, scheduler port, composition factories, projections, explanation service,
  public routes, CLI commands, schemas, examples and implementation-specific tests.
  Removed unused Thing occurrence fields from private Run contracts and planning.
- Removed unused Thing/Routine table grants from control and reconciler roles,
  Routine submission/artifact grants, and obsolete Lambda environment variables.
  Ingress and scheduler IAM now target Session integration state.
- Connection consumer reporting uses Sessions, schedules, connection sets and
  source bindings. Notification connections do not imply Agent tool access.
- Browser takeover/teaching ports, private routes, runner branches and domain types
  are removed. The local browser tool helper retains autonomous execution, output
  bounds and process isolation.
- README, operating model, agent guide, schedule guide, API route inventory and
  primary discovery links describe the new primitives. The Thing lifecycle diagram
  and site build dependency on that diagram are removed.
- Public Run/conversation routes and commands, public projections, submission wrappers,
  and obsolete console presentation/artifact/activity helpers are removed.
- Quickstart and the opt-in AWS/console smoke harness use standard Sessions.
- Session artifact publications and SDK Files/artifact CLI commands replace the old
  artifact source selectors; no legacy public route is needed to share saved output.
- Codex is pinned to `0.154.0`; worker packaging requires the patched source artifact and matching upstream companions. The relay retains the pinned protocol client.
- Deleted the entire conversation lifecycle, DynamoDB adapter, contracts, coordinator
  and completion Lambdas, preparation ports, queue adapter and resume-and-post path.
- Session launches alone select persistent harnesses. The owner-and-Session hash,
  S3 Files mount and native journal remain intact. Private hook configuration now
  uses `sessionStorageKey` and `SESSION_STATE_ROOT`.
- Removed coordinator Lambda packages, event mappings, completion targets, roles,
  table/queue grants, explicit resume permission and obsolete environment settings.
  Retired AWS data is isolated in `infra/modules/agent-runner/retired-data.tf`;
  historical logs remain at their existing addresses. Disposable LocalStack fixtures
  no longer create the conversation table or queues.
- Dispatch, worker admission and queue recovery reject retired conversation Run
  records. Recovery planning takes an explicit timestamp and yields only a private
  execution queue message. No old transcript is executed under the new contract.
- Architecture documentation, SVG and explorer now explain Sessions, Turns,
  the outbox, native journals and independent terminal Turn delivery. AGENTS.md
  and dependency checks no longer describe a conversation layer.

The deployed `thing-schedule` Lambda and schedule group retain their physical
names. They execute the new Session schedule contract. Thing/Routine tables remain
in Terraform solely to avoid silently deleting deployed data; application code no
longer accesses them. Existing source bindings and Scheduler payloads need an
explicit deployment cutover; they are not automatically interpreted as Agents.

## Next cycle: execution order and acceptance

Execute these remaining tasks in order; the detailed sections below also record
completed removals so they are not recreated:

1. Run the prepared isolated AWS API/managed Session/transport/console cases and
   add canonical provider, schedule, recovery, credential and webhook failure cases.
2. Audit private activity/artifact helpers and integration administration grants
   against actual callers; remove only code and grants with no retained consumer.
3. Complete the deployment cutover inventory for old queues, source bindings and
   schedules. Export retained data and obtain an explicit disposition before deletion.
4. Consolidate overlapping Vault/connection plumbing only with equivalent provider
   installation, grant narrowing, refresh and delivery-fencing coverage.
5. Measure the native build improvements listed at the end after AWS acceptance.

### 1. Finish deployment canaries and onboarding

The automated AWS quickstart now creates a standard Agent, completes two root
Turns in one Session, verifies saved assistant Items, and deletes the proof
Session to close its harness. Version 4 metadata records these resources. Old
metadata remains readable for deployment recovery only. The helper requires real
Codex and an admitted model before setup/preflight; credential-transfer consent,
AWS identity, diagnostic artifacts and teardown remain intact.

The opt-in AWS API canary now verifies binary Files, deletion, denied anonymous
access and two saved Session Turns. Its console counterpart exercises Session
creation, continuation, reload and cleanup. Both require explicit model opt-in.
The old provider/conversation mega-canary, named-thread console, browser takeover,
NVIDIA and Linear account demo tests are retired. Private executor, Session recovery and provider policy suites remain; removing a public
canary does not establish its replacement's live coverage.

Port these scenarios to canonical Sessions before claiming deployment parity:

- Managed environment command execution and saved artifact capture now have a prepared canary, including idempotency, SSE, guest boundaries and same-process continuation; execute it on AWS. Explicit CloudFront publication still needs a canonical live case.
- Signed GitHub/GitLab/Slack/Teams bindings, occurrence replay, per-sender continuity
  and terminal Turn delivery, including missing or rejected credentials.
- Scheduler occurrence deduplication, overlap and outbox repair in deployed AWS.
- Harness launch/attach ambiguity, liveness fencing, execution loss, cancellation,
  reconnect, replacement execution and saved native checkpoint recovery.
- Credential grants, provider scope narrowing, rotation/revocation, OAuth refresh,
  and blocked operations before credential access under the deployed role.
- Failure queue baselines, bounded diagnostics, streaming and large files through
  the dedicated HTTP/relay deployment. The default canary uses the Lambda URL.

Inventory remaining provider setup helpers, `scripts/aws-e2e-*.sh`,
`testing/run-*.sh`, and `testing/aws/` resources/env exports. Remove unused provider
fixture resources only after deciding which live cases will use them. Require owned
Agent/environment bindings before sending canaries that can start work. Keep all
live provisioning and model calls opt-in.

### 2. Consolidate the private artifact and browser implementations

Session publications now select explicit saved artifact IDs and relative output
paths through `POST /v1/sessions/{sessionId}/publications`. They validate ownership
and the full reference set before object reads, and retain immutable file/site/video
publication, signed redemption and expiring grants. The pure planner computes
selection, source scope, content identity and provenance; the service owns reads,
copying, commit and grant creation.

The automatic `.rat-things/share.json` publisher, its worker branches, environment
flag, prompt instructions and catalog-only publication calculations are removed.
`PublicationGrantStore` lives with the retained publication service. Session
publication remains explicit and owner scoped; stored grants remain redeemable.
The simulated browser capture proof now publishes selected Session artifacts.
Cloud Run catalog/patch branches are removed. Local CLI output collection remains useful and is retained.

Public and private Run browser takeover/control/teaching routes, bridge methods,
lease/teaching state and unused DTOs are removed. Standard Agents receive no
undeclared browser tools. The local Chromium helper retains navigation,
observation, screenshots, recording, bounded output, URL/path validation,
serialization and the unprivileged browser process.

### 3. Public route and CLI retirement is complete

Removed `/v1/runs`, `/v1/conversations` and all nested routes from control, API
Gateway and OpenAPI. Removed unreachable OpenAPI components, public projections,
`RunSubmissionService`, `ConversationSubmissionService` and their factories/tests.
Discovery describes Agents and application integrations.

Removed legacy command implementations and implicit interpretation of a retired
command as a local prompt. The CLI retains local execution, doctor, connection
management, schedules and the standard Agent/Session/environment/Vault groups.
`files` uses the SDK Files API; `sessions artifacts` and `artifact-content` use
saved Session artifacts; `publications create` uses the separate application
contract. The console launcher retains isolation between separately launched
identities and no longer accepts retired Run/thread selectors.

Continue searching auxiliary scripts and learner pages for retired commands.
Private `/agent-runtime/v1/runs/{runId}/...` control URLs address the supervised
Session harness. The separate POST `/agent-runtime/v1/runs` continuation endpoint
is removed.

### 4. Duplicate conversation lifecycle is removed

`src/conversation/`, its domain contracts and DynamoDB adapter, both lifecycle
Lambdas and their tests are deleted. Run planning/service/store ports no longer
prepare a second execution input or accept conversation bindings. The executor
no longer selects a preferred MicroVM or resumes it to post another Run.
Session outbox and runtime journal now own continuation. Private Run dispatch,
heartbeat, cancellation and terminal generation fencing remain.

Current S3 Files resources still serve Sessions. Their physical names and
`/conversations` access-point root are intentionally unchanged. The new hook uses
`sessionStorageKey`; the worker receives `SESSION_STATE_ROOT`. Build and roll out
the control plane and MicroVM image together so these private field names agree.

Private dispatch, worker admission and queue recovery ignore retained records
with the retired `conversation` or `executionInput` fields. They do not migrate or
replay old work. During deployment cutover, inspect and deliberately cancel/drain
old executions before disabling their handlers. Inventory retained records and
logs rather than assuming ignored queued records will complete themselves.

`agent-activity-projection.ts` and `saved-agent-activity.ts` still support private
diagnostics. Review them with the private/local artifact cleanup, rather than
restoring the old lifecycle to justify retaining them.

### 5. Active infrastructure is pruned; deployed data disposition remains

The coordinator/completion packages, Lambda definitions, event-source mapping,
EventBridge target and permission, IAM roles/policies, queue/table grants,
explicit resume permission and obsolete environment settings are removed.
Root and AWS harness package maps are updated. LocalStack no longer provisions
conversation fixtures. Historical coordinator/completion logs remain explicitly
retained at their existing Terraform addresses.

`infra/modules/agent-runner/retired-data.tf` contains the Thing, Routine and
conversation tables plus the conversation wake-up, dispatch-failure and
completion-failure queues. They retain the same addresses, indexes, physical
names and retention policies. No application role has access. Existing TTL and
SQS expiry still apply; this is not an archival guarantee. Inspect/export their
data and choose final retention or deletion before removing resources or outputs.
Do not apply a destroy plan merely to finish code cleanup.

The S3 Files bucket/filesystem/access point is active Session storage and must
not be retired with these resources. Existing schedule-group/role physical names
also remain valid. Replace old provider bindings with owned Agent/environment
bindings and disable/reconcile old Scheduler payloads before updating a deployed
target. No AWS plan or deployment has been applied by this code cleanup.

Agents HTTP, token issuance and outbox IAM/composition are split from the broad legacy control policy. Audit remaining broad control-role grants against retained integration callers.
Review buffered forwarding and Lambda streaming fallback once the HTTP service
is the required transport. Keep token issuance and health/discovery.

Acceptance: packages match Lambda definitions, Terraform validates, and a reviewed
plan contains only intended retirements with explicit data disposition.

### 6. Consolidate retained integrations and remaining documentation

Keep connection installation, OAuth refresh, provider scopes, operation/resource
grants, health checks and credential brokering. Vault/connection plumbing may be
consolidated only while preserving those behaviors; a Vault alone does not replace
provider installation or persistent grants. Rename residual internal
`SourceCapabilityBinding` / `source-policies.ts` identifiers if that improves
clarity; their behavior now resolves Agent Session targets.

The consumer/documentation sweep is complete across the quickstart, API, provider,
capability, security, cost and deployment pages, guides and overview. Source-binding
examples use Agent/environment targets; obsolete console media and historical C4
diagrams are removed. Deployment/model comparisons and old cost evidence are
archived in `plans/`. Maintain these pages when remaining integration behavior
changes; do not relabel historical validation as proof of this migration.

AGENTS.md boundaries now reflect the removed conversation layer.
Carry ownership, signature checks, deduplication, ordering, grant narrowing,
redaction and delivery fencing tests into the new paths alongside code deletion.

## Final verification

- Re-scan imports and old route/command strings across `src`, `infra`, `testing`,
  `scripts`, `spec`, `console`, `docs`, `guides`, `site`, `examples` and `e2e`.
  Classify private execution concepts separately from obsolete public contracts.
- Run `npm run check`, `npm run smoke:local` and `npm run test:e2e:console`.
  Run LocalStack and ARM64 image tests when Docker is available; neither these
  nor local protocol fixtures establish live AWS provisioning/model compatibility.
- Verify canonical provider/schedule retries, ordering, owner separation,
  cancellation, terminal delivery, deleted-Session fencing and recovery.
- Exercise admitted models, configured MCP servers, programmatic tools, deferred
  search, environment capabilities and reconnect in an explicitly opted-in AWS
  deployment before claiming 100% behavioral compatibility.
- Record command results and deployment limitations in the change description or
  test artifacts; learner documentation should teach behavior rather than QA history.

## Concrete removal batches from the current call graph

Completed batches are retained here to distinguish them from outstanding work.
Public retirements are complete; remaining entries concern private implementation
and deployment helpers.

1. **Browser administration — complete:** removed the unused port/adapter methods,
   MicroVM routes, runner bridge branches, takeover/teaching state, domain DTOs and
   associated tests. Retained local agent-driven browser tools and added an effect
   ordering check covering an action failure followed by another action and close.
2. **Automatic publication — complete:** removed `src/runner/publications.ts`,
   `src/core/publication-publisher.ts`, their worker callers and environment config.
   File instructions are now a pure calculation without a sharing environment flag.
   Moved the still-used grant port into `publication-service.ts`; removed obsolete
   catalog identity/selectors. Kept Session publication, grant and redemption code.
3. **Cloud catalog writers — complete:** removed cloud catalog restore,
   collection, workspace-patch and obsolete browser/integration launch branches.
   `tests/runner/finalization.test.ts` now checks canonical Session bindings and
   journal persistence before private finalization. Keep local CLI output collection in
   `src/cli.ts` and `localArtifactPaths` until it has a deliberate replacement.
   The browser publication simulation now uses explicit Session artifact selections;
   obsolete share-file/publisher tests are removed. Session publication tests retain
   owner/scope checks and immutable commit reuse.
4. **Least-privilege deployment — locally implemented:** the token issuer, HTTP
   and outbox now have distinct policies/composition. Token issuance no longer
   inherits provider administration. Deployed IAM evidence remains required. Preserve webhook visibility
   changes, durable stream permissions, OAuth refresh and cancellation. Remove
   remaining obsolete exports; `THINGS_TABLE_NAME` has been removed from deployment
   and LocalStack environment exports. Keep physical schedule-group names and active
   Session storage mounts. Do not delete retained deployed tables or queues.
5. **Deployment proof:** replace the retired provider/schedule/recovery canaries
   with the scenarios listed above. The current API and console proofs cover a
   smaller surface. Test the advertised direct HTTPS API hostname, five-minute
   connection waits, relay disconnection, large Files, webhooks and saved artifacts.
   Keep source configuration, provider credentials and external message sends
   explicit in each opt-in live scenario.

The migration's API now uses the direct HTTPS ALB hostname with a 360-second idle
timeout. The relay retains CloudFront. The former CloudFront-only origin prefix
list is removed; application and relay authentication remain enforced, and task
ports accept traffic only from the load balancer.

## Follow-up after EC2 acceptance

- Removed unused control-role Agents/Run stream access, outbox queue access and
  outbox log grants. The dedicated outbox role retains its required permissions.
- Retire MicroVM-specific launch, proxy transport, idle/suspend configuration and
  build resources only after EC2 passes live isolation/lifetime/recovery tests and
  the operator has deliberately migrated existing workers. Keep physical Session
  S3 Files storage and retained data addresses stable.
- Consolidate the shared worker launch configuration naming and the currently
  MicroVM-named interaction controller once both-backend rollout is complete.
- LocalStack no longer provisions the obsolete Things/Routines tables or exports
  ROUTINES_TABLE_NAME. This changes disposable fixtures only.

## Latest readiness and documentation cleanup

- The site overview now describes Agent/Session/Turn/Item/Vault workflows and removes
  retired CLI commands, browser takeover and Routines console screenshots. The site
  build no longer publishes those obsolete console assets.
- Historical Grok comparisons moved from learner docs into `plans/`. Historical
  pricing calculations are archived in `plans/legacy-cost-baseline.md`; current cost
  pages describe connected workers and the HTTP/relay baseline. Nine unreferenced conversation/Routines console and old CLI images are deleted.
  Remaining provider demo media needs a separate accuracy/reference review.
- The AWS harness forwards dedicated HTTPS image/hostname/certificate inputs. It
  records account/region before apply, and teardown now handles exact-template EC2
  workers and runtime-created Agents secrets as well as connection secrets.
- Provider/schedule/credential/recovery live scenarios above remain a separate
  concrete execution list. Prepared tests and local fixtures are not live evidence.

- Removed `testing/run-teams-codex-e2e.sh` and its npm command: it selected a deleted
  conversation-era test name, and the current LocalStack suite injects fake execution.
  Keeping the wrapper would misrepresent a zero-case run as real Codex/provider
  coverage. Teams learner docs now explain Session receipts and saved-Turn delivery.

- Replaced retired handoff/chat examples in laptop-continuation, durable-state,
  subscription, integration and Slack-to-Linear guides. Updated Slack/Linear learner
  pages to distinguish declared Agent tools from notification connections. Archived
  the old Linear demo narrative in `plans/` and stopped publishing its historical
  media. Retained media is historical evidence, not current product validation.

- Moved the unreferenced pre-migration quickstart evidence JSON into `plans/` and
  removed four unused historical C4 PNGs. Current architecture SVGs and the
  interactive explorer remain the published diagrams.

- Removed `scripts/onboard-github.ts`, its obsolete configuration tests and npm wrappers.
  It deployed the old default-driver setup without creating the Agent/environment source
  binding now required by ingress. GitHub setup now documents explicit signed-hook and
  owned binding configuration. Existing deployment metadata and secret values are untouched.
- Rewrote capability/security guidance around resolved Sessions, dedicated workers, explicit
  tool credentials, private control, saved artifacts and unknown delivery outcomes. Removed
  stale Thing publication, browser takeover and active-Run response claims. Corrected the
  source-binding example and removed the remaining Run/Thing narrowing guide text.

- Removed the deployment-wide `default_agent_driver` switch from Terraform, worker payloads,
  lifecycle configuration and deployment scripts. Canonical Sessions always launch Codex;
  they can no longer silently execute a mock or bypass model credential checks. Explicit
  local mock execution remains an offline development tool. Updated channel/deployment docs.
- EC2-only deployments no longer create unused MicroVM S3 Files network connectors.
  Shared storage resources remain stable, with access granted to the enabled worker roles.

- Finished the overview-page sweep: removed Thing revision activation, browser takeover/teaching,
  retired transcript/reaction promises and pre-migration timing/cost numbers. The current page
  explains Session resources and deployment cost drivers; historical cost evidence remains in
  `plans/legacy-cost-baseline.md`. Schedule recovery docs now use generations and occurrences.

- Removed the four unreferenced legacy C4 SVG/Mermaid pairs. They described the retired
  conversation coordinator and old harness paths; current focused SVGs and the interactive
  architecture explorer remain. Their historical versions are available in Git history.

- Removed the worker template's unconditional medium reasoning setting. Session Agent
  configuration and the pinned model catalogue now determine reasoning, without a deployment
  template overriding native defaults for model identifiers absent from that catalogue.

## Native build efficiency after AWS acceptance

The complete upstream CLI includes interactive components that the cloud harness does not use.
Its cold single-job ARM64 build takes hours on an 8 GiB machine. Keep the current complete
package through acceptance, then evaluate these bounded changes in a separate cycle:

1. Check whether upstream supplies a supported harness/executor-only build that retains every
   command required by `CodexRpcClient`, the executor connection and environment tooling.
   Inventory those command paths before changing packaging; do not replace the harness protocol.
2. Measure build time, peak memory and artifact size on a larger ARM64 runner with additional
   Cargo jobs and, separately, a different release optimization profile. Record compiler/profile
   inputs in artifact provenance and the cache key.
3. Accept a packaging/profile change only after strict native Agents fixtures, worker isolation,
   browser and companion-resource checks pass. Keep source/patch and checksum validation.

The native CI cache already excludes unrelated TypeScript dependency changes.
The strict test image installs dependencies directly as UID 10001 and copies files
with that ownership, avoiding a second dependency layer from recursive `chown`.
