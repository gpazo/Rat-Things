# Agents API compatibility audit — 2026-09-13

Full compatibility is not established. This audit tracks route coverage, API
behavior fixes, explicit effect boundaries and verification failures. It does not
close the behavioral or deployed acceptance work in
[the conformance ledger](agents-api-conformance.md).

## Contract and hosting

The [OpenAI overview](https://developers.openai.com/api/docs/guides/agents-api/overview)
defines Agents, Environments, Sessions, Events and Items. Its
[architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
keeps the harness at OpenAI even for a self-hosted environment. Rat Things instead
operates the API and harness as well as compute and storage in AWS. Compatibility
therefore needs an explicit distinction between public API behavior and the
operator's hosting implementation.

The existing repository contract targets the official SDK with a replacement
base URL. Public DTOs import `openai@7.15.0` types directly. No fresh comparison
against every current reference field or every hosted-service behavior has been
completed by this audit.

## Findings and changes

- The pinned SDK defines 58 operations across Agents, Vaults, Files and Skills.
  All 58 are present in `spec/agents-api-routes.json`, with no extra operations
  in that inventory. This does not inventory separate application routes.
- The old route generation check compared generated output to the repository's
  own inventory. It could miss a newly introduced SDK endpoint. The check now
  independently extracts operations from the installed SDK source and rejects
  missing, extra and duplicate inventory routes. It fails if a recognized HTTP
  operation uses an unrecognized path expression. Negative probes verified all
  three mismatch cases without changing the working inventory.
- `authorizeConnectionOperation` previously read the wall clock when `now` was
  omitted. It now requires an explicit time. The integration runtime obtains
  time at preparation and again at invocation, preserving expiry revalidation
  before credential access. The domain calculation has no implicit clock read.
  Focused coverage checks the instant before expiration and expiration itself.
- Session planning already receives time and IDs as values and returns state
  and commands. That is a useful functional boundary. This focused inspection
  is not a certification that every calculation in the repository is pure.

## Preserve and retire

Preserve the Lambda MicroVM backend, trusted-runner/guest separation, Session
journals, S3 Files mounts, identity and credential boundaries, conditional writes,
and useful provider/schedule/delivery integrations through canonical Sessions.

The existing removal ledger records removal of public Thing, Routine, Run and
conversation contracts. Private Run execution records still support Session
execution; their names alone do not establish conflicting public semantics.
`infra/modules/agent-runner/s3-files.tf` deliberately retains historical resource
addresses and the `/conversations` mount root for Session workspaces and native
state. Removing those addresses as a cosmetic cleanup could damage the integration
the user wants to preserve. No infrastructure or stored data was deleted here.

Remaining removal and migration work is tracked in
[obsolete implementation removal](obsolete-implementation-removal.md). Its
completion claims still require caller and deployment verification; this pass
does not certify that every obsolete implementation has been removed.

## Verification

- Restored pinned dependencies with `npm ci` after the initial schema check failed
  because `ts-json-schema-generator` was unavailable.
- `npm run check`: architecture, schema, generated routes, generated workers,
  TypeScript and MicroVM syntax checks passed before the test phase. The suite
  reported 815 passing, 17 failing and 11 skipped tests; later packaging, site
  and Terraform stages were not reached.
- Failures include native/CLI/setup timeouts, missing `jq`, and unexpected login
  shell startup output in a shell fixture. These are unresolved results, not proof
  of API incompatibility or permission to dismiss all failures as environmental.
- Serial rerun of domain capabilities, integration runtime and executor relay:
  26 tests passed. The executor connection failure did not reproduce in this run.
- A second serial rerun of native Sessions, Files/Skills and environment MCP:
  13 tests passed and one failed. The managed stdio MCP sandbox still timed out
  during initialization; its cause remains unresolved. Native Session and
  Files/Skills failures did not reproduce. These are ordinary diagnostic native
  tests, not the strict repeated patched-runtime parity gate.
- The final route coverage check passed; isolated missing/extra/duplicate probes
  each failed with the intended inventory diagnostic.
- A separate `npm run package` built the JavaScript bundles but failed when it
  required the exported patched Linux ARM64 Codex runtime. Supply the artifact
  through `CODEX_RUNTIME_ARTIFACT` or build it using the documented runtime builder
  before claiming a deployable package.

The existing conformance ledger retains open work for complete field/limit/error
coverage, remaining Item/event variants, usage/compaction, recovery and concurrency
races, native multi-agent behavior in AWS, long-lived environments, and deployed
streaming/file/tool/credential behavior. Local schema matching and successful
fixtures cannot substitute for that evidence. No cloud resources were provisioned
and no live model calls were made during this pass.

## Priority remediation

The following work addresses the reproducible findings without marking the
broader behavioral acceptance ledger complete:

1. **Managed MCP initialization:** a minimal native sandbox probe on macOS
   13.7.8 x64 exits with code 65 because Seatbelt rejects the pinned profile's
   `TIOCSTI` symbol. The fixture RPC helper now rejects pending requests on process
   failure/closure and rejects calls after closure. It drains final stdout before
   handling process closure, preserves falsey responses, and settles pending calls
   during caller cleanup. Four lifecycle tests pass. The sandbox compatibility
   check remains failing; neither skipping it nor disabling isolation is a fix.
2. **CLI and shell validation:** command selection now precedes loading the Agents
   schemas, AWS signing clients, executor or local-runner dependencies. The console
   loads signing dependencies when handling an authenticated request. The focused
   CLI/console/quickstart/shell rerun passes all 35 tests with existing deadlines.
   Shell fixtures use non-login Bash. Homebrew could not install `jq` because its
   local version rejected the current formula; the official jq 1.8.2 Intel macOS
   binary was downloaded to ignored `.runtime/tools/jq` and verified against the
   [published checksum](https://raw.githubusercontent.com/jqlang/jq/master/sig/v1.8.2/sha256sum.txt).
   Test commands in this follow-up prepend `.runtime/tools` to `PATH`.
   Vitest now runs at most two suites concurrently because native suites spawn
   additional concurrent processes; per-operation deadlines remain unchanged.
3. **Native packaging:** the packager verifies the complete native artifact before
   replacing any Lambda archive. A regression test verifies that a missing runtime
   leaves an existing archive untouched; all six artifact tests pass. Unsupported
   native build hosts fail before creating a build directory or fetching source.
   CI now archives and exports the complete runtime after the native worker image
   passes, preserving executable modes and companion resources in a tarball.
   No matching local artifact, running Docker daemon or published native CI export
   was available for this checkout. A current verified export or ARM64 build host
   is still required to complete packaging and native image acceptance.
4. **Obsolete CLI surface:** removed option declarations with no retained consumer,
   including conversation IDs, legacy Run selectors, browser-takeover coordinates
   and old interactive-answer flags. These now fail as unknown options instead of
   being accepted by the general parser. The canonical Agents CLI parses its own
   options before that parser. The repository guide no longer describes Thing
   narrowing. S3 Files resource addresses, mount roots and runtime behavior are
   unchanged.

The workflow YAML parses, builder/packager syntax checks pass, and an unsupported
host probe leaves no build directory. CI export execution still needs verification
on the configured ARM64 runner; no workflow was dispatched or cloud resource
provisioned during this follow-up.

The follow-up `npm run check` passed architecture, schema/route/worker generation,
TypeScript and MicroVM syntax checks. With bounded suite concurrency its test phase
reported **835 passing, two failing and 11 skipped tests**. The remaining failures
are the macOS managed stdio sandbox profile rejection and a managed executor's
connection to its network proxy returning `EPERM`. The latter also reproduced in
isolation; the test now exposes the safe error code rather than only exit code 3.
Its cause has not been established, and it must be reproduced against the Linux
ARM64 deployment runtime before it can be closed. The check remains red.

Separate JavaScript build, local mock smoke and site build checks passed after
the changes. Formatting and validation also passed for all three Terraform roots
(`infra`, `testing/localstack`, `testing/aws`). Provider initialization only added
local platform checksums; those incidental lockfile changes were removed. The
missing native artifact still prevents a complete deployable package and native
image verification.

## Further remediation

- **Session tool resets:** creating a Session with a saved MCP Agent and
  `agent.tools: null` returned HTTP 500. Public configuration correctly cleared the
  tools, but a nullish fallback restored the saved transports during credential
  preparation. The service now distinguishes omission from an explicit reset
  before calling execution ports. An SDK regression reproduced the failure before
  the fix and verifies that both `null` and `[]` prepare no MCP bindings or
  credentials; omitted tools preserve saved transport headers and leave the saved
  Agent unchanged. This follows the
  [configuration override contract](https://developers.openai.com/api/docs/guides/agents-api/configuration).
- **Retained backends:** removed the obsolete plan to retire MicroVM launch,
  transport, suspend and build resources after EC2 acceptance. Both backends remain
  supported; the existing S3 Files storage and resource addresses stay intact.
  The conformance ledger now distinguishes earlier candidates' results from
  verification of this working tree.
- **Native diagnosis:** prepared and source-audited the exact pinned Codex checkout
  and its existing patches. `codex-rs/cli/src/debug_sandbox.rs` appends the `TIOCSTI`
  deny rule specifically in the macOS CLI sandbox path; app-server command execution
  uses the shared sandbox policy without that CLI addition. The source explains
  why the managed MCP command fails on this host while app-server execution can
  start. No sandbox rule or native patch was weakened or replaced.
- **Proxy and build access:** all twelve fresh local proxy probes returned the
  expected HTTP 403 `not_allowed` response, and the focused managed-executor test
  passed. These successful reruns do not explain or close the earlier intermittent
  `EPERM`. Failures now report only the socket error code, syscall, address and
  port. The configured AWS profile failed the read-only STS identity check with
  `InvalidClientTokenId`; it cannot currently access a build host. There is still
  no usable local Docker daemon or matching ARM64 artifact. No cloud resources
  were provisioned and no model calls were made.
- **Test discovery:** preparing native source exposed Vitest's default discovery
  of upstream Jest suites inside ignored `.runtime` directories. Test discovery
  now targets this repository's `tests/` tree. The native fixtures remain included;
  the source checkout's separate test harness is not imported into the repository
  suite.

Final verification for this follow-up:

- `npm run check` passed architecture, schema/route/worker generation, TypeScript
  and MicroVM syntax checks. Its test phase reported **837 passing, one failing
  and 11 skipped tests**, across 138 repository test files. The only failure was
  the managed MCP sandbox exiting 65 on this macOS host. Later check stages were
  not reached. Log: `/tmp/rat-proceed-final-check.log`.
- `npm run build` passed. Log: `/tmp/rat-proceed-build.log`.
- The explicit test inventory exactly matches all repository test files, and
  `git diff --check` passed.
- Full packaging, strict Linux ARM64 image acceptance and deployed validation
  remain open. Completing them requires the matching patched runtime and a
  working ARM64/container execution environment; AWS-based verification also
  requires valid AWS credentials. Passing proxy reruns are not a root-cause fix
  for the previously observed intermittent failure.

## Session preparation and retry safety

Failure injection reproduced loss of inherited MCP headers after interrupted
setup, failure to recover committed snapshot/Session writes after lost
acknowledgements, and revocation of adopted MCP secrets when a retried binding
write reported a conflict. The fixes preserve the existing Session primitives:

- Preparation snapshots retain the saved Agent's inherited tool settings as well
  as its public resolved configuration. Retrying after that Agent is edited or
  deleted retains the original settings. Inline Session authorization and env
  values are excluded from these snapshots and remain in the secret store.
- A digest of the original request prevents changed input, environment or tool
  parameters from resuming the same pending preparation. Concurrent creators use
  the committed snapshot before continuing effects. Older incomplete MCP
  snapshots fail with `session_preparation_incomplete` instead of silently
  dropping headers or rereading a changed Agent.
- Snapshot and final Session writes recover from a committed result after an
  acknowledgement failure. Existing deletion fencing and initial-Turn
  deduplication remain covered.
- MCP transport validation and binding recovery are pure calculations. The
  service validates the complete transport list before its vault reads or secret
  creation, and performs recovery reads before cleanup. Secrets referenced by
  committed bindings are protected; only unadopted references from the losing
  attempt are eligible for cleanup. An absent or failed read leaves an uncertain
  write's credentials intact and propagates the original error.

Thirteen focused recovery cases cover these behaviors, unchanged input values,
inline-secret separation and unavailable recovery reads. The initial regression
run reproduced five failing cases before implementation. `npm run check` then
passed architecture, schema/route/worker generation, TypeScript and MicroVM syntax
checks and reported **850 passing, one failing and 11 skipped tests** across 139
files. The sole failure remains the managed MCP sandbox exiting 65 on this macOS
host; packaging and later check stages were not reached. Check log:
`/tmp/rat-preparation-check.log`. A separate JavaScript build passed:
`/tmp/rat-preparation-build.log`. The site build and `git diff --check` also passed.

Unknown secret-creation outcomes that return no reference, cleanup failures and
eventual reconciliation of unadopted secrets remain separate work. This pass
protects committed credentials; it does not establish orphan-free cleanup under
every failure. ARM64 packaging, native-image acceptance and deployed AWS checks
remain blocked by the previously recorded runtime/access limitations. No cloud
resources, MicroVM configuration or S3 Files resources were changed.

## Durable Session tool credential cleanup

Session tool preparation now reserves credential names and persists a
`session_tool_attempts` record before calling Secrets Manager. The record contains
references and lifecycle state, not confidential headers or environment values.
Transport validation and the wait/adopt/cleanup decisions remain pure functions;
time, identity generation, storage transactions and secret effects stay in the
service and adapter.

Binding adoption and the attempt's `adopted` transition commit atomically. Cleanup
must first win a conditional transition to `cleanup`, which prevents delayed
adoption. An unavailable read or an unfenced missing binding cannot authorize
revocation. Pending attempts become eligible for outbox cleanup after five minutes; cleanup
failures retain their records for retry. Session deletion atomically removes the
bindings and records their cleanup. The DynamoDB stream filter, job parser,
independent FIFO group and Lambda consumer all carry this work, including attempts
that never produced a Session.

The Secrets Manager adapter accepts the persisted name before creation, so a lost
creation acknowledgement cannot lose the cleanup identity. For uncertain names,
retirement occupies the name with a credential-free value before scheduling
seven-day deletion. Legacy ARN bindings retain idempotent deletion. A reservation
that is not yet observable is retried, rather than treated as successful cleanup.
This relies on Secrets Manager's name uniqueness and recovery-window behavior;
it does not establish an unbounded fence for a create request paused beyond that
window. See AWS's [CreateSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html)
and [DeleteSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html)
contracts. Deployed timing and IAM verification remain required.

The first full verification also exposed an environment file-helper cleanup
failure: `ENOTEMPTY` under `.tmp/plugins-clone-*/.git`. The pinned Codex source
starts curated plugin synchronization when the plugins feature is enabled
(`core-plugins/src/manager.rs`, `maybe_start_curated_repo_sync_for_config`). The
file-only RPC helper now starts with `features.plugins=false` before
initialization. Its declared file MCP server and encrypted executor transport
remain in use. The native relay test passed after this change. The
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes the plugin feature switch; the startup synchronization diagnosis comes
from the pinned source and the failing cleanup path.

This work provides recovery for newly recorded credential attempts. It does not
inventory untracked secrets left by older deployments. A separate Session
preparation retention policy is still needed for bindings already adopted by a
preparation whose final Session write never completes. Those references remain
reachable in `session_tools`; this reconciler protects them to preserve retries.
Full API compatibility also still requires the remaining conformance-matrix
acceptance work, Linux ARM64 image validation and deployed AWS verification.

Verification for this follow-up:

- All 24 added credential/outbox cases passed: 12 reconciliation cases, eight
  Secrets Manager adapter cases, three Lambda delivery cases and one additional
  stream-planning case. Existing Session preparation/lifecycle and MCP cases
  also passed.
- Final `npm run check` passed architecture, schema/route/worker generation,
  TypeScript and MicroVM syntax checks. Its suite reported **873 passing, two
  failing and 11 skipped tests** across 142 files. The failures were the existing
  managed MCP sandbox exit 65 and a 5-second integration CLI timeout. The CLI case
  passed separately in 1.56 seconds; concurrent build/provider validation may
  have contributed, but this is not a proven root cause or a timeout fix. Logs:
  `/tmp/rat-credential-reconciliation-final-check.log` and
  `/tmp/rat-credential-reconciliation-cli-retry.log`.
- The environment relay test passed both separately and in the final suite after
  disabling plugin sync for file-only helpers. The initial full run's
  `ENOTEMPTY` failure is retained in
  `/tmp/rat-credential-reconciliation-check.log`.
- `npm run test:infra` passed both mocked worker backend cases, including the new
  stream-filter assertion and existing MicroVM/S3 Files assertions. Terraform
  validation, formatting and `git diff --check` passed. Provider initialization
  added verified Intel macOS package hashes to the existing lock file without
  changing provider versions. Logs:
  `/tmp/rat-credential-reconciliation-infra.log` and
  `/tmp/rat-credential-reconciliation-validate.log`.
- JavaScript and site builds passed. Explicit packaging rebuilt JavaScript, then
  stopped at the missing patched Linux ARM64 Codex artifact. Logs:
  `/tmp/rat-credential-reconciliation-build.log`,
  `/tmp/rat-credential-reconciliation-site.log` and
  `/tmp/rat-credential-reconciliation-package.log`.

No cloud resources were provisioned or changed. The Terraform change adds the
cleanup collection to the existing stream filter; MicroVM and S3 Files resource
addresses and permissions remain intact. This local verification does not claim
full API parity or deployed credential cleanup acceptance.

## Restored AWS access and recovered runtime

AWS access was revalidated as `macbook-intel-agent` in account `731841023867`.
The local checkout has no retained `.aws-e2e` deployment record, but read-only
inventory found the existing `ag260913a` deployment in `us-west-2` and its public
API at `https://agents-ag260913a.dev.indubitably.ai/v1`.

Bounded live validation against that deployment passed:

- Health, IAM token issuance and authenticated Agent listing.
- An 8 MiB binary File upload/download with a SHA-256 comparison, exact byte
  metadata, rejected anonymous access and confirmed deletion.
- Agent creation, retrieval, metadata update and confirmed deletion.
- The current local `SecretsSessionTools` adapter against live Secrets Manager
  using the deployment's KMS key: creation followed by an injected lost
  acknowledgement, recovery by reserved name, repeated retirement, inaccessible
  values after retirement, and rejection of creation at a previously retired
  unused name. Both disposable secret names have confirmed deletion dates;
  their seven-day recovery windows remain in effect. This ran with the caller's
  credentials and does not prove the deployed outbox role or consumer behavior.

The API canary created no Session, launched no worker and made no model calls.
Its File and Agent were removed. Reports are in the ignored
`.runtime/aws-validation/api-report.json` and `secret-report.json`.

The live Agents stream filter still omits `session_tool_attempts`. The local
credential-cleanup changes are therefore not deployed, and restored account
access alone does not close their end-to-end acceptance requirement.

A matching runtime was recovered read-only from the existing ECR repository
`rat-things-ag260913a/accepted-worker`, tag `validated`. Its ARM64 image manifest
is `sha256:8fa72c4a7cb26b954987af67f4208be6308e4d69d635cfff2a4826e9b201a775`;
the runtime layer is
`sha256:4c97378a2a5450036751a495dd218ac821c9bcb996c70d2132b6639c9bc0f330`.
The compressed layer digest was verified before extracting regular files beneath
`opt/codex-runtime`. The repository's existing `codexRuntimeEntries` validator
then accepted its exact source/patch identity, provenance, file hashes,
companions and Linux ARM64 executable headers. The recovered artifact lives at
`.runtime/codex/recovered-ag260913a`, with `.runtime/codex/linux-arm64` pointing to
it. This closes the missing local artifact prerequisite; it does not execute the
ARM64 runtime on this Intel macOS host.

`npm run package` now passes, including the JavaScript build, all Lambda and
MicroVM source archives, and Lambda bundle smoke checks. Log:
`/tmp/rat-restored-aws-package.log`. No deployment or infrastructure update was
performed. Full repository checks still require resolution of the recorded
macOS sandbox failure and intermittent CLI timeout; native image and deployed
cleanup acceptance remain open.

## Credential cleanup deployed and verified

The user authorized proceeding with the deployment after restored-access checks.
The existing `ag260913a` installation was updated in place, with its previous
Lambda bundles, ECS task definition, image manifest and stream filter saved under
`.runtime/aws-validation/rollout/` before mutation.

Deployment scope and ordering:

1. Updated `rat-things-ag260913a-agents-outbox` using the already packaged local
   bundle, with a conditional revision check and successful Lambda update wait.
2. Added only `session_tool_attempts` to the existing Agents-table stream filter.
   The Runs completion mapping and SQS consumer mapping were preserved.
3. Published an immutable ARM64 image by adding the current
   `/app/agents-server.mjs` to the existing accepted relay image. Its runtime,
   image settings, task settings, execution role, network and mount configuration
   were preserved. The bundle diff was reviewed against the deployed bundle.
   The image is
   `731841023867.dkr.ecr.us-west-2.amazonaws.com/rat-things-ag260913a/accepted-relay@sha256:bdc49243e00bc0fbcb06a2759507e4529dade22966da9d636fe40d7b44a5bc54`.
4. Rolled the `agents-http` service from task revision 4 to revision 5 with its
   existing 100% minimum healthy capacity. ECS reported the new deployment
   `COMPLETED`, one running task and no pending tasks.
5. Updated the control Lambda, which also exposes canonical Agents routes.
   Both updated Lambdas reported `Active` and `Successful`.

Six live outbox checks passed against actual DynamoDB, encrypted S3 definitions,
DynamoDB Streams, SQS, the deployed Lambda role and Secrets Manager:

- A pending credential remained readable before its deadline.
- An expired reservation was retired and its attempt removed.
- A never-created reservation was retired and its attempt removed.
- An adopted attempt was removed while its credential remained readable.
- A future-deadline attempt was retried and retired after the deadline.
- Atomic binding deletion produced cleanup work that the outbox completed,
  retiring the previously adopted credential.

The canary did not call the reconciler locally or invoke the Lambda directly.
Assertions checked the completed effects before its final defensive cleanup.
Only uniquely identified canary records and credentials were used. Record
values contained references, not confidential transport values. Evidence:
`.runtime/aws-validation/rollout/outbox-report.json`.

A real SDK Session through the dedicated HTTPS API also passed: self-hosted,
no initial input, inline MCP credentials, no Turn or worker launch. The stored
binding used the new reserved-name format, public Session responses excluded
the confidential value, and API deletion removed the Session and bindings and
made its credential inaccessible. Evidence:
`.runtime/aws-validation/rollout/session-report.json`.

This checkout still has no copy of the original deployment Terraform state.
The new image input is recorded in
`.runtime/aws-validation/rollout/deployment-image.tfvars.json` for use with that
state on the next infrastructure apply. The checked-in stream filter already
contains the new collection. The producer rollback script restores the previous
API and control versions while retaining the compatible cleanup consumer, so
newly recorded cleanup work is not stranded. No rollback was needed.

No MicroVM was provisioned, no model inference was requested, and S3 Files or
worker resource configurations were not changed. Disposable credentials have
scheduled deletion dates; ordinary encrypted resource history/tombstones follow
the existing storage retention behavior. This closes the deployed credential
cleanup path tested here, not the entire API compatibility matrix. Native image
acceptance, broader lifecycle/transport cases, legacy orphan inventory and
abandoned-preparation retention remain separate acceptance work.

The same Session credential lifecycle canary passed through the IAM-signed
control endpoint at `https://t2sulf1cej.execute-api.us-west-2.amazonaws.com/v1`,
confirming that its alternate canonical Agents route also uses reserved names
and retires credentials on deletion. Evidence:
`.runtime/aws-validation/rollout/control-session-report.json`.
`git diff --check` passed after recording the rollout.

## Machine-switch priority follow-up

The user confirmed that the original Terraform state remains on the other
machine. This checkout must not recreate that state. The shared HTTP/relay image
input is now tracked in `testing/aws/releases/ag260913a-image.json`, with handoff
instructions beside it. `../codex` is available at
`6f39a47bb3b04de4c804187bfbf55edc56939aab`; it also contains the repository's pinned
native source commit. Its checkout was not modified. The current host remains
Intel macOS 13.7.8, and Docker is unavailable.

New Session creation now records preparation before credential effects for both
ordinary API requests and integration retries. A pure planner supplies the
one-day completion deadline and classifies waiting, completed, legacy and
abandoned preparations. Final Session commit and MCP binding adoption compare
and swap the same preparation revision. Cleanup first fences the preparation,
then removes bindings with the existing durable credential-cleanup journal.
Completed/abandoned identities remain as retry fences; records are not deleted
by a TTL that could revive a delayed creator. Older preparations without a
deadline require explicit inventory. This closes adopted inline credentials left
behind by unfinished creation; abandoned environment connections and old
pre-deadline snapshots still require separate disposition.

The outbox processes `session_preparations` in an independent FIFO group and
revisits long waits hourly, leaving headroom below SQS's receipt-relative
12-hour visibility ceiling. The stream filter and mocked Terraform assertion
include the new collection. Six new lifecycle tests exercise both race winners,
ordinary HTTP preparation, delayed adoption, lost fence acknowledgement,
cleanup retry, owner isolation and legacy preservation. The focused run passed
52 tests. The final full check passed architecture, generated contracts,
TypeScript and MicroVM syntax and reported 881 passing tests, one failure and
11 opt-in skips. The remaining failure is the existing macOS managed stdio
sandbox exit 65; the CLI timeout did not recur. No isolation setting was relaxed.
Logs: `/tmp/rat-priority-final-check.log` and `/tmp/rat-preparation-tests.log`.
Packaging passed all 14 Lambda smoke checks. Both mocked Terraform tests, the
site build and all three Terraform validations passed. Logs:
`/tmp/rat-priority-final-package.log`, `/tmp/rat-priority-infra.log`,
`/tmp/rat-priority-site.log`, `/tmp/rat-priority-terraform.log`.

The metadata-only inventory of `ag260913a` read no secret values. It found eight
inline Session credentials, all already scheduled for deletion, and no live
preparation records. This scope does not certify unrelated older deployments.
Evidence: `.runtime/aws-validation/credential-inventory.json`.

The preparation changes were deployed consumer-first to the existing outbox,
stream filter, HTTP/relay services and control Lambda. The live cleanup canary
passed five assertions: waiting credentials remain readable, expired and
future-deadline preparations become fenced and lose their bindings/credentials,
and completed and legacy preparations preserve their credentials. Both API
endpoints passed real SDK Session creation/deletion with a committed one-day
preparation snapshot and confidential transports excluded from public output.
Fixture credentials were retired and fixture records removed. Reports live in
`.runtime/aws-validation/preparation-rollout/`. No model inference or MicroVM
provisioning was requested by these tests.

The recorded long-soak Session returned 404 to the current API principal. A
consistent DynamoDB/S3 read subsequently found it under another owner with one
completed Turn and no deletion marker. That is not proof of soak success or
failure; recover the other machine's outcome/cleanup records. Evidence:
`.runtime/aws-validation/soak-store-status.json`.
Earlier evidence documents now explicitly identify their candidate, and the
stale claim that no patched AWS worker had ever been deployed is corrected.

### Live relay TLS diagnosis

A direct stock `exec-server --remote` invocation rejected the custom hostname
before connecting. `../codex` confirms its API-key host restriction, and the
repository already handles it with the local registry adapter behind
`environments connect`. Repeating through that existing adapter established an
encrypted live executor connection. A local harness then performed file
operations through the deployed relay, while the API's deployed file helper
returned 503.

A disposable ARM64 Fargate probe, using the existing relay role/network and only
a fixture secret reference in its overrides, isolated the failure to native
TLS certificate verification during `thread/start`. It did not execute a model.
The native client reported `unable to get local issuer certificate`; Node could
connect because it carries its own CA roots. The probe completed, its task
definition was deregistered and its temporary ECR image was removed. Fixture
Sessions and credentials were cleaned up. Redacted diagnostics and cleanup
records are in `.runtime/aws-validation/relay-probe/`.

`relay/Dockerfile` now exports the pinned Node image's public root certificates
for OpenSSL and sets `SSL_CERT_FILE`. The isolated file helper explicitly passes
that path to Codex. The image gate validates that the readable bundle contains
CA certificates. TLS verification remains enabled. The in-place ARM64 image
repair used the same Node 22.23.2 public root bundle, with 145 certificates;
no user-added or application credentials are included. Current image and task
records are under `.runtime/aws-validation/tls-rollout/` and the tracked image
handoff file. This is a scoped runtime repair, not an ARM64 full-suite pass.

The post-TLS full repository check again reported 881 passes, one macOS sandbox
failure and 11 skips (`/tmp/rat-relay-tls-check.log`). Local CLI smoke passed.
Playwright's pinned Chromium installer rejects macOS 13, so the console's two
local workflows were run with installed Chrome 152 using a temporary config;
both passed, with the live model case skipped. Videos were disabled for this
verification. The repository's browser defaults were unchanged. Logs:
`/tmp/rat-priority-smoke.log`, `/tmp/rat-priority-console-chrome.log`.


After the TLS repair, the deployed API file helper wrote and listed a 2 MiB
binary through the encrypted relay to the local stock Codex executor. Exact
bytes matched on disk. The scoped registry adapter, local harness comparison,
deployed helper and Session cleanup all passed without inference or a worker
launch. Evidence: `.runtime/aws-validation/relay-rollout/report.json` and
`/tmp/rat-live-relay-tls-canary.log`. This closes the observed deployed file-helper
TLS failure. The API and relay services are healthy on the tracked image pin;
final task/Lambda/filter checks are in `.runtime/aws-validation/tls-rollout/final-state.json`.
Final packaging and site build also passed (`/tmp/rat-relay-tls-package.log`,
`/tmp/rat-priority-final-site.log`).

Remaining priority gates: reconcile the original Terraform state/inputs on the
other machine; run native/LocalStack acceptance on a supported ARM64 Docker
host; recover the existing soak's final evidence and test worker replacement;
finish the behavior matrix and provider/scheduler/credential integration cases;
and disposition legacy deployment data and abandoned environment connections.
The current pass does not certify every API behavior or Lambda MicroVM execution.

## Session lifecycle races without Terraform state

The next local behavior pass rechecked the official
[Session guide](https://developers.openai.com/api/docs/guides/agents-api/sessions)
and reproduced two counterexamples before fixing them:

- Closing a Session before its first runtime claim previously wrote no closure.
  A dispatch paused while storing its launch could subsequently claim the deleted
  Session. Runtime closure now persists an owner-scoped, non-expiring record with
  no Run ID when none exists. Claim CAS and an explicit closed-state check reject
  both stale and freshly reread claims. Closure returns the record it actually
  fenced, so a concurrent winning claim is the one selected for cancellation.
- If a start reached the harness but its outbox acknowledgement failed, a later
  cancellation and dispatch retry unconditionally stored `cancelled`. This could
  overwrite native completion or failure, or prematurely report cancellation
  while the harness was still active. Cancellation now observes the native Turn;
  a pure decision marks only queued, unstarted work cancelled and preserves
  admitted outcomes. A concurrently persisted terminal Turn also wins.

Focused cases cover closure before dispatch, HTTP deletion during paused launch,
a claim winning the first closure write, owner isolation, repeated closure,
rejected publication/reclaim, and completed/failed/in-progress/waiting outcomes
after an unacknowledged start. The changes use plain state values and an injected
clock for closure planning; storage, cancellation and observation remain explicit
service effects.

Verification: the focused lifecycle/journal/execution/webhook suite passed all
53 cases. `npm run check` passed architecture, generated-contract checks,
TypeScript and MicroVM syntax, then reported 889 passing tests, 11 skips and the
existing macOS managed-stdio sandbox failure (`RPC process closed`, exit 65).
Because that failure stops the command chain, packaging, site build and all
three Terraform format/validation roots were run separately and passed.
Packaging smoke-tested all 14 Lambda bundles against the verified ARM64 artifact.
Final TypeScript and `git diff --check` also passed. Logs are
`/tmp/rat-session-races-{check,package,site,typecheck}.log`.

This candidate has not been deployed. Terraform state and AWS resources were
untouched. Broader deletion versus metadata/input writes, worker admission after
an existing claim, steering races and deployed lifecycle acceptance remain open.

## Native admission retry and Git handoff

The native Session runtime cached rejected `start` promises even when its
pre-admission check had sent no request to Codex. A follow-up received while the
root was active (or its first start was awaiting acknowledgement) remained
permanently rejected after the root completed. Input submitted before runtime
initialization had the same problem. All three cases reproduced locally.

The pure `rootTurnBusy` decision now runs before recording the native attempt.
Only attempts crossing the native boundary enter the identity cache. A retry
after a busy/uninitialized rejection can therefore proceed, while an ambiguous
native acknowledgement still closes the harness and cannot replay the Turn.
Four regression cases and existing execution/runtime cases passed: 29 focused
tests in total. Child work can still continue independently of root admission.

The portable continuation guide is
[`testing/aws/releases/ag260913a-handoff.md`](../testing/aws/releases/ag260913a-handoff.md).
It distinguishes deployed code from the local lifecycle candidate, identifies
the original state/runtime/soak evidence that Git does not transfer, and orders
the remaining ARM64, state-reconciliation and live acceptance work. The changes
are collected on `codex/agents-api-compatibility`; no live deployment was changed
during this pass.

Final handoff verification: `npm run check` passed the architecture, generated
contracts, TypeScript and MicroVM syntax gates, then reported 893 passing tests,
11 skips and the same macOS managed-stdio sandbox exit-65 failure. Separate
packaging (14 Lambda bundle smoke checks), site build and all three Terraform
format/validation roots passed. Logs are
`/tmp/rat-machine-handoff-{check,package,site}.log`. The staged files exclude
runtime exports, private deployment inputs, state, backups and build output.
