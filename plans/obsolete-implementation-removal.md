# Obsolete implementation cleanup

The Agents API migration's obsolete-code cleanup is complete for the
`ag260913a` test deployment. The user authorized deletion of legacy test data
without archival on September 26, 2026. This supersedes the historical retention
requirements and pending lists previously recorded here; Git history preserves
that audit trail.

## Removed application paths

- Public Run, conversation, Thing and Routine APIs, CLI commands and projections.
- Conversation coordinator/completion services, queues' producers and consumers,
  adapters, packages, event mappings, and their IAM permissions.
- Browser takeover/teaching controls, automatic legacy artifact publication,
  catalog restore/writers, workspace patches and unused activity projections.
- Legacy onboarding/test wrappers, stale deployment defaults and unused control
  permissions. The [caller audit](obsolete-caller-audit-2026-09-14.md) records the
  retained consumers and reviewed IAM removals.

Provider ingress, schedules and delivery use canonical Agents and Sessions.
Existing provider, credential, scheduler, webhook, recovery and native test
fixtures remain useful; the release evidence is recorded in
[the closeout](agents-api-closeout-next.md).

## September 26 retirement batch

- Remove the former Things, Routines and conversations DynamoDB tables.
- Remove conversation wake-up, failure and completion-failure SQS queues.
- Remove coordinator/completion CloudWatch log groups.
- Remove their module, root and AWS test-harness outputs. Correct the retained
  scheduler outputs to describe Session schedules.
- Remove sixteen historical Linear demo media files and the obsolete Connections
  screenshot, including its documentation and site-copy references.
- Keep the historical Linear narrative explicitly marked as referring to removed
  media available in Git history.

The saved Terraform plan uses the original deployment state and release image
pins. It contains eight retired-resource deletions, with no application image,
Lambda package or active data-store replacement. Nine IAM documents are
recomputed because of the log-group dependency; their normalized policy inputs
are unchanged. After apply, all nine resulting policy JSON values matched the
prior state. AWS readback confirmed the eight retired resources absent and both
API/relay services running at their desired count. State lineage is unchanged;
serial advanced from 620 to 638. Evidence is under
`.aws-e2e/ag260913a/cleanup-20260926/`.

## Inventory and retained consumers

- The deployment's integrations table has no source bindings; its Scheduler
  group has no schedules. No legacy bindings or schedule payloads need migration.
- Versioned definition objects use the `agents` namespace. Artifact objects use
  `runs`, `sessions` and `files`. These are current resource namespaces, not an
  identified legacy object collection. This cleanup does not empty active buckets.
- Every `scripts/aws-e2e-*.sh` and `testing/run-*.sh` helper has an active npm,
  script, test or harness-documentation reference. The integration fixture and
  its audit queue support credential, MCP and webhook canaries. No further
  unused fixture was identified in this bounded review.
- Keep private Run execution, saved diagnostics, local artifact discovery,
  explicit Session publication and its grants.
- Keep the active S3 Files storage, `conversation_state` resource addresses and
  `/conversations` filesystem root: Sessions use them.
- Keep the physical `thing-schedule` function, Scheduler group and failure queue:
  they execute the current Session schedule contract.
- Keep EC2 and Lambda MicroVM backends, current architecture media and site assets.

## Optional follow-up: native build efficiency

This is performance work, not unfinished API or obsolete-code cleanup. The
complete pinned Codex package remains the accepted runtime.

1. Check whether upstream provides a supported harness/executor-only build with
   every command and companion resource used by Rat Things.
2. Measure cold build time, peak memory and artifact size before comparing more
   ARM64 build capacity or release profiles.
3. Accept a change only after strict native protocol, executor, isolation and
   browser tests pass; preserve source, patch and checksum provenance.

Do not remove supported runtime components merely because they are large.

## Verification

`npm run check` passed after the final site cleanup: 1,119 tests passed,
50 opt-in cases skipped, with architecture/contracts, packaging, site generation
and Terraform validation passing. No new inference or worker provisioning was
needed. An initial drift read overlapped packaging and stopped on a missing
transient bundle; the final post-packaging drift check passed with no changes.
