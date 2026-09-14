# Private helper and administration permission caller audit

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

## Next reviewable IAM batch (not applied)

These are concrete control-role candidates, separate from the ongoing soak. Keep
outbox counterparts and verify both direct HTTPS and Lambda fallback deployments.
Do not mutate the shared action lists blindly: the outbox and other roles have
retained consumers that the control role does not.

1. Remove the control policy's `SessionSchedules` and `PassSessionScheduleRole`
   statements in `infra/modules/agent-runner/iam.tf:219` and `:230`.
   `control.ts:333` exposes create/list/update/status operations, all of which only
   persist schedule definitions in `ScheduleService`. The sole production caller
   of `synchronize` is `src/lambdas/agents-outbox.ts:35`; only that method invokes
   the Scheduler adapter. Retain both equivalent outbox statements in
   `infra/modules/agent-runner/agents-iam.tf:91` and `:96`.
2. Remove the control policy's `SessionDeliverySecrets` at `iam.tf:319` after the
   composition reachability check is captured in a regression test. Control
   constructs `SessionIntegrationService` through schedule composition but does
   not invoke submission or delivery. The executed delivery entry points are the
   outbox's `deliverReady` and the notifier handler. Neither plain construction
   of `DeliveryService` nor schedule definition validation reads notifier secrets.
   Keep outbox `DeliveryConfiguration` and notifier-role grants.
3. Narrow control-specific DynamoDB actions after a focused policy check:
   `DynamoRunStore` uses Get/Query/Put/Update, without Delete; the control integration
   store uses Get/Query/Put and transactional Put, while OAuth state consumes Delete.
   No control integration Update caller was found. Preserve OAuth Delete and
   connection bundle/source-claim transactions. Delivery fencing does use Update
   in another role, so do not remove Update from the shared integration list.

Acceptance for that future batch: assert control administration does not execute
Scheduler or provider delivery; retain schedule synchronization and retry tests;
verify rendered policy scopes and a no-resource-replacement Terraform plan; then
run deployed schedule, provider credential and publication canaries after the
soak permits infrastructure changes. This audit alone is not deployed IAM proof.

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
