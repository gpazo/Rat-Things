# Private helper and administration permission caller audit

Current disposition: [completed obsolete implementation cleanup](obsolete-implementation-removal.md). The sections below preserve the original caller evidence and its validation chronology.

This is a source caller audit performed while the AWS long-running observer is
active. It does not establish live API parity. No AWS resources, Terraform
configuration, deployed images, credentials or retained data were changed by this
batch. It follows the functional-programming skill: preserve useful pure
projections and filesystem boundaries, remove effects with no retained caller.

## Removed locally

Repository-wide symbol searches across source, scripts, tests and harnesses found
no production callers of these branches. Tests of retired behavior do not justify
keeping the implementation.

| Removed branch | Caller evidence before removal | Retained behavior |
| --- | --- | --- |
| `projectPublicAgentRuntime`, pending-request/question projection and aggregate DTOs | Only `tests/core/agent-activity-projection.test.ts` imported the aggregate projection. Saved diagnostics import `projectPublicAgentEvent` directly. | The pure saved-event projector remains, including bounded commentary, sequence values and redaction of raw commands, prompts, results and native identifiers. Tests now exercise that retained function directly. |
| `restoreArtifactCatalog`, `publishArtifactCatalog`, `clearArtifactDirectory` and their private checksum/copy/restore/recursive ownership helpers | No caller in production source, CLI, packaging scripts or harnesses. The only calls were catalog-specific tests. | `src/cli.ts:259` prepares the local directory; `src/cli.ts:270` lists local output. Preparation, ownership handoff, sorted relative paths, path validation and symlink rejection remain. |
| Catalog publication/scope planners, catalog-only hashing/limits/validator and empty catalog helper | Used only by the removed writer/restore branch and its tests. No Session artifact capture or Session publication call imports them. | Shared artifact file-count/path bounds remain in `src/domain/artifacts.ts`; canonical publication validation still imports them. Media sniffing and agent identity functions remain at their original domain/runner modules, with direct tests. |
| Catalog-only effect tests | Exercised the retired upload, copy, restore and automatic catalog lifecycle. | Local output discovery tests now verify directory creation, preservation of nested output, symlink rejection and invalid path rejection. Saved diagnostic and Session publication coverage remain. |

The local execution prompt no longer promises automatic durable cataloging during
private Run finalization. It describes the retained local output listing. It
preserves the caller's exact request, including empty or whitespace input.

## Retained private consumers

- `RunService.savedActivity` (`src/core/run-service.ts:123`) retains owner and
  terminal-state checks, retrieves the immutable saved event object and calls
  `savedAgentActivity`. Its checksum, bounded stream parsing and event projection
  remain unchanged. The private Run execution contract was not removed.
- `src/runner/agent-planning.ts:47` still builds the local artifact instructions.
  Standard managed Sessions continue to use their separate native harness and
  `/workspace/outputs` capture path.
- `src/core/session-artifact-capture.ts` and the Session publication service retain
  their own saved artifact references, scope checks and explicit publication flow.
  The browser helper remains autonomous and was not changed.
- `PublishedArtifact` in the private Run result remains as a retained record shape;
  `ArtifactCatalog` remains used by publication fixture data. Removing a dead
  writer does not authorize discarding saved Run fields or historical objects.
- `tests/runner/artifact-fixtures.ts` remains used by canonical Files, HTTP and CLI
  tests. It was not deleted with the catalog-only tests.

## Control IAM cleanup (implemented September 23; deployed September 24)

The continuation removed these control-role permissions after caller and
composition verification. Outbox counterparts and shared action lists remain.

1. Removed the control policy's `SessionSchedules` and `PassSessionScheduleRole`
   statements in `infra/modules/agent-runner/iam.tf`.
   `control.ts:333` exposes create/list/update/status operations, all of which only
   persist schedule definitions in `ScheduleService`. The sole production caller
   of `synchronize` is `src/lambdas/agents-outbox.ts:35`; only that method invokes
   the Scheduler adapter. Retain both equivalent outbox statements in
   `infra/modules/agent-runner/agents-iam.tf:91` and `:96`.
2. Removed the control policy's `SessionDeliverySecrets` after the
   composition reachability check passed in a regression test. Control
   constructs `SessionIntegrationService` through schedule composition but does
   not invoke submission or delivery. The executed delivery entry points are the
   outbox's `deliverReady` and the notifier handler. Neither plain construction
   of `DeliveryService` nor schedule definition validation reads notifier secrets.
   Keep outbox `DeliveryConfiguration` and notifier-role grants.
3. Narrowed control-specific DynamoDB actions with focused policy checks:
   `DynamoRunStore` uses Get/Query/Put/Update, without Delete; the control integration
   store uses Get/Query/Put and transactional Put, while OAuth state consumes Delete.
   No control integration Update caller was found. Preserve OAuth Delete and
   connection bundle/source-claim transactions. Delivery fencing does use Update
   in another role, so do not remove Update from the shared integration list.

`tests/lambdas/control-schedules.test.ts` exercises the real control composition
with schedule create/list/read/update/pause/resume/delete and guards every AWS
client and outbound fetch. None is called. Invoking outbox synchronization then
trips the Scheduler guard, proving the guard is connected. Eight focused tests
pass, including retained schedule retry behavior. Three Terraform scenarios pass
for EC2, both worker backends and dedicated relay administration, checking the
control action sets, retained delivery grants and API role selection. The full
check passes 1,015 ordinary tests with 20 opt-in skips, then stops at the pending
new-native-artifact packaging gate.

Transactional writes retain their underlying item grants; DynamoDB does not
require a separate `TransactWriteItems` permission for these Put operations
([AWS transaction IAM guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)).
The September 24 cycle applied the reviewed plan through the original state
without replacing retained data stores. The deployed `lambda-control` policy was
read back: `SessionSchedules`, `PassSessionScheduleRole` and
`SessionDeliverySecrets` are absent; no retained Thing/Routine/conversation table
grant remains. Run actions exclude Delete and integration actions exclude Update
while retaining OAuth Delete. The live scheduler and credential canaries passed
in this cycle; broader publication/provider acceptance remains in the ledger.
The policy readback is saved under the ignored `parity-20260923` evidence folder.

## Grants that still have consumers

| Grant family | Retained consumer / reason |
| --- | --- |
| Integration secret Create/Delete/Describe/Put/Get and Tag | Connection installation/rotation/revocation, health checks and OAuth refresh. `SecretsManagerCredentialVault.create` sends tags as part of CreateSecret; lack of a standalone TagResource command does not make its permission obsolete. Describe supports idempotent deletion. |
| OAuth application reads | OAuth authorization and refresh use application credentials through `getOAuthApplicationRegistry`; removing them would break provider installation and token refresh. |
| Integrations table reads/writes | Connection bundles, grants, aliases, source claims, connection sets, health and OAuth state remain exposed by the administration routes. |
| Agents table reads/writes | Source/schedule target validation and connection consumer reporting use canonical Agents resources. The control handler also retains selected Agents routes. |
| Run/queue/runtime, Agents secrets and object permissions | When the dedicated relay is disabled, `lambda.tf:94` still assigns the control role to the full `agents-api` Lambda. Private Session execution and runtime control remain necessary for this supported deployment mode. |
| S3 artifact writes/reads and publication signing key | Explicit Session publication stages/copies/commits immutable objects and creates grants; share redemption reads the signed grant and signing secret. No legacy catalog writer is needed for those operations. |
| Definitions objects | The canonical resource store uses encrypted definition bodies outside DynamoDB. Do not classify this bucket by its old name alone. |

## Validation

- September 24 repeat scan across active source, scripts, infrastructure, docs,
  guides, examples, harnesses and console found no removed submission/catalog/
  aggregate-runtime symbols. The only Run URL matches are the retained private
  `/agent-runtime/v1/runs/...` control paths. This does not authorize deletion of
  retained AWS data or removal of supported execution backends.

- Targeted retained behavior: 65 tests passed across local artifact discovery,
  artifact instructions/media/identity, saved event projection, Run service,
  agent planning, canonical CLI and publication planning.
- Additional canonical publication checks: 44 tests passed across Session
  publication, publication service, builders, sharing and domain validation.
- Full repository verification passed after parallel source edits stabilized:
  893 tests, 14 opt-in skips, packaging/site and all three Terraform validations.
  Evidence: `.aws-e2e/ag260913a/parallel-contract-cleanup-check.log`.
- Post-removal source/test symbol scan found no remaining references to the
  removed functions. Retained paths above were inspected explicitly.
