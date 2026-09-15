# AWS validation resumed on the state-owning ARM64 machine

The [AWS-hosted observer continuation](aws-live-observer-2026-09-14.md) records
the subsequent soak diagnosis, client changes and new cloud-hosted run.

Branch: `codex/agents-api-compatibility`, beginning at `8352c39`.
Deployment: `ag260913a`, account `731841023867`, region `us-west-2`.
The original state, inputs, runtime environment and soak logs remain under
`.aws-e2e/ag260913a/`; private backups are in its `resume-backup/` directory.
The original state lineage is `be69a19a-2f46-d753-8dc0-0884b98a7269` and had
308 managed instances at serial 383. No replacement state was created.

Current deployment: the handoff changes, input-write contention fix and queued-Turn
attribution fix are deployed through that original state, now serial 430. The
final plan has no drift, and all ten S3 bucket/DynamoDB table identities match the
pre-resume backup. Final local acceptance passes 901 repository tests, 210 strict
native ARM64 tests and four LocalStack workflows. The final API/managed-workspace
rerun passes, and all three final lifecycle/worker-loss cases pass. All fixture
workers are terminated. Detailed evidence and earlier failures follow. The
deployment remains available for continued validation.

## Recovered original soak

The wrapper finished with test exit 1 and cleanup exit 254. The failed test
assertion expected the second completed Turn on the original SSE connection.
No second completion was observed there. The cleanup log records an AWS request
signature expiry while deleting a runtime credential; Terraform teardown was
not reached. Neither a complete test pass nor complete cleanup can be claimed.

Consistent DynamoDB reads and referenced encrypted S3 objects now establish:

- Both original Turns completed. The original Session is tombstoned, and its
  runtime is closed. No EC2 worker remained at the initial inventory.
- All three retained artifact hashes match their recorded SHA-256 values.
- The continuation artifact has the same process nonce and marker as the first
  artifact, with an elapsed time of 29,395.675 seconds, exceeding 29,100 seconds.
- UID 10001, control-port/metadata/host-configuration denial and the unchanged
  original artifact are preserved in the proof.

This recovers evidence of process continuity, workspace persistence and a real
second model Turn after eight hours. The original uninterrupted-stream assertion
still failed; its cause is not established. New reconnect coverage must be
reported separately. Evidence: `soak-live.log`, `soak-teardown.log`,
`resume-soak-report.json`, `resume-soak-artifact-report.json`. Raw owner-scoped
records remain private beside those reports.

## Acceptance on this host

| Gate | Result | Local artifact |
| --- | --- | --- |
| Dependency install | Passed | `resume-npm-ci.log` |
| Full repository check | 894 passed, 13 opt-in skips; packaging/site/three Terraform roots passed | `resume-final-check.log` |
| Mocked Terraform backend tests | 2 passed | `resume-infra.log` |
| ARM64 HTTP/relay image | Passed health, discovery, authentication, unprivileged execution and TLS roots | `resume-relay-image.log` |
| ARM64 worker image | Passed isolation, cgroup/BPF network controls, browser and VP8 recording | `resume-worker-image.log` |
| Strict native Linux ARM64 | 203 passed | `resume-native-image.log` |
| LocalStack | 4 passed, harness removed its local containers/volumes | `resume-localstack.log` |
| Local CLI smoke | Passed | `resume-smoke.log` |
| Local console | 2 passed, live case skipped | `resume-console.log` |

The existing runtime export matches the pinned source and patches. No sandbox
control was disabled to pass the macOS or Linux tests.

## Cleanup correction and live candidates

The EC2 cleanup selector previously expected a `LaunchTemplate` field in an
instance description. EC2 exposes the association through its immutable
[`aws:ec2launchtemplate:id` tag](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/launch-instances-from-launch-template.html).
The selector now checks that tag together with deployment, Run and generation.
The fixtures use the actual response shape and reject missing or mismatched
template tags. All three cleanup tests pass.

New opt-in live cases cover cancellation while a native function result is
pending, reconnect-before-read, follow-up admission, and exact-worker failure
injection. Worker-loss injection requires its own flag, account check and exact
launch-template identity. Native checkpoint loss and replacement-compute
workspace restoration remain distinct unverified cases.

First resumed image candidates (subsequent API fixes below supersede the relay):

- Worker: `sha256:5e3a5333fea716a22b7121d9361d5e999dd7cb32f4f593e9623fb9c5da51eb93`.
- HTTP/relay: `sha256:514dc8f96b992647eda3639073950a060c48f3b724fb9073cac6cc080d3bd08b`.

The reviewed plan uses the existing state and saved inputs, incorporating the
handoff deployment drift. It updates Lambda code, the launch-template version,
dispatch policy references and ECS services. Only two ECS task definitions are
replaced; storage is preserved and no Lambda MicroVM is provisioned.
Saved-plan apply must include `-state="$state_file"` with this legacy local-state
harness, just as plan does. An initial invocation without it was rejected for
different state lineage before changing resources. The corrected apply is
recorded in `resume-deploy.log`: 2 task definitions added/replaced, 13 resources
updated. State retained its original lineage and reached serial 402. All 11
checked storage identities were unchanged. The checked Lambda hashes matched
their local packages (`resume-lambda-hashes.json`). Both ECS services stabilized
on the accepted image before the live cases ran.

## First resumed live findings

- Cancellation while waiting for a function result, SSE reconnect-before-read,
  a new completed follow-up and deletion passed in 116 seconds.
- The basic live API proof passed in 108 seconds: authentication, binary Files,
  two model Turns and deletion.
- The managed canary failed on its second input with HTTP 409, before the input
  was saved. The first Turn completed and cleanup deleted the Session. The API
  planned against a Session revision that background history/dispatch updates
  could change before its conditional write. A local terminal-history race
  reproduced this failure. Receipt contention and deletion races also reproduced.
- The original replacement test destroyed a hosted environment and then expected
  it to resume. The API rejected this with `The session has failed`. That
  expectation conflicts with the documented
  [hosted-sandbox expiry rule](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted):
  create a new Session after expiry. The fixtures now separate terminal hosted
  loss (saved artifacts remain readable) from harness-only loss in a Session
  with no environment (a replacement worker must retain conversation context).
  The failed initial fixture is preserved as evidence, not relabeled a pass.

Evidence: `resume-lifecycle-recovery-live.log`, `resume-managed-api-live.log`,
`resume-managed-conflict-report.json`. The failure-injection worker was selected
by exact deployment, Run, generation and AWS-owned launch-template tags.

Session input now re-reads and replans only rejected conditional writes. Its
receipt identity remains fixed, concurrent history is preserved, ambiguous
acknowledgements are not automatically replayed, and deletion remains a 404.
Three regression cases failed before the change; all four new cases and 26
related cases pass afterward (`resume-input-race-{before,after}.log`). The full
check passes 898 tests with 14 opt-in skips (`resume-race-fix-check.log`). The
updated HTTP/relay image gate passed. Worker bundle hashes are unchanged.
The input race fix was deployed with HTTP/relay digest
`sha256:c90e73872627fca263220c9d6cbbbb6ae9b6e6cb129b07e829e8241d1d08446f`.
The reviewed plan replaced only two ECS task definitions and updated nine
resources. Both ECS services stabilized; a subsequent plan reported no drift.
The full acceptance check passed 898 tests with 14 opt-in skips, and strict native
Linux ARM64 passed 207 tests. LocalStack passed four cases and removed its fixtures.

## Repeated live acceptance and recovery finding

| Case | Result | Artifact |
| --- | --- | --- |
| Managed workspace, persistent process, isolation, artifacts, SSE and second input | Passed, 130 seconds | `resume-managed-api-live-2.log` |
| API authentication, binary Files, two model Turns and deletion | Passed, 109 seconds | `resume-managed-api-live-2.log` |
| Cancellation during a function wait, reconnect-before-read, follow-up and deletion | Passed, 119 seconds | `resume-lifecycle-recovery-live-2.log` |
| Hosted worker loss is terminal; saved artifact remains readable | Passed, 120 seconds | `resume-lifecycle-recovery-live-2.log` |
| Harness loss with no environment, then follow-up | Failed before replacement dispatch: new queued Turn incorrectly projected as failed | `resume-lifecycle-recovery-live-2.log` |
| 8 MiB binary checksum, byte count and deletion | Passed, 12 seconds | `resume-http-webhook-live.log` |
| Full five-minute disconnected input deadline, HTTP 408 with SSE still open | Passed, 302 seconds | `resume-http-webhook-live.log` |
| Committed Session event to deployment-owned HTTPS capture | Passed | `resume-http-webhook-live.log` |
| Console creates, continues and reloads model Turns | Passed, 1.9 minutes | `resume-console-live.log` |

The harness-loss failure exposed premature status attribution: the runtime still
points at the previous terminal Run while the outbox has not dispatched new input.
Without native acknowledgement or a launch bound to the new Turn, that Run does
not establish failure of the new input. Observation now preserves its queued
status, and Item reads do not project the old harness output onto it. A saved
active Turn still fails when its own harness stops. The targeted regression failed
before the fix; all 43 targeted checks pass afterward. The final full check
passes 901 tests with 14 opt-in skips, packaging/site and all three Terraform
roots. The strict native ARM64 suite passes 210 tests. The updated image passes
health, discovery, authentication, non-root execution and native TLS checks.
The recovery image is pinned as
`sha256:3da2d216202dedee5b44faf23837261e12b27ad81fb5be9f12759b8786837bd6`
in `testing/aws/releases/ag260913a-image.json`; its worker image is unchanged.
The reviewed recovery rollout completed: two ECS task definitions replaced and
nine resources updated, with no storage or worker change. State reached serial
430 on its original lineage. All seven updated Lambda hashes match their local
packages. The final Terraform plan exits zero with no drift. LocalStack again
passes four workflows and removes its containers/volumes. Evidence:
`resume-recovery-{final-check,native-final,relay,localstack,deploy,final-drift}.log`,
`resume-recovery-lambda-hashes.json` and `resume-recovery-worker-hashes.json`.
The apply succeeded; its first follow-on ECS waiter used task-family names rather
than service names and returned MISSING. The corrected waiter uses `agents-http`
and `environment-relay` and completes successfully. Both healthy containers run
the pinned recovery digest. The final managed-workspace canary passes again in
132 seconds and the API workflow passes in 109 seconds
(`resume-managed-api-live-final.log`). The final
lifecycle file has passed cancellation/reconnect in 118 seconds and harness-only
recovery in 203 seconds. It terminated fixture worker `i-0649308770e5937ae`;
replacement `i-0d56b439498c82b73` completed the follow-up with the saved marker and
SSE completion. Hosted-expiry revalidation also passes in 117 seconds: further
input is rejected and the saved artifact remains readable. All three cases pass
in `resume-lifecycle-recovery-live-final.log`. A direct comparison of all ten
S3 bucket and DynamoDB table identities with the pre-resume backup passes
(`resume-final-state-proof.json`).

The post-test queue inventory has no messages in any failure queue, the private
Run queue, delivery capture, integration audit or retired conversation queues.
It records 16 retained terminal-capture events and 43 visible/16 in-flight Agents
outbox messages. These were not purged. Preparation reconciliation can defer a
FIFO head for up to an hour; this inventory does not prove every residual message
has drained. Recent outbox warnings include conditional-write conflicts and one
transaction cancellation during concurrent live work. Confirm eventual drain and
absence of repeated failures in the next acceptance step. Evidence:
`resume-final-cleanup-report.json`.

The exact-instance termination waiter completed successfully. The final EC2
inventory at 15:39:54 UTC contains no pending, running, stopping, stopped or
shutting-down workers for this deployment. The stack, captured evidence and
deferred outbox records remain intact; no queues were purged.

## Remaining acceptance

This cycle does not establish complete API parity. Prioritize:

1. Retain the completed long-stream soak as evidence while continuing the
   remaining live recovery cases; the original eight-hour second-completion SSE
   assertion remains a historical failure even though artifacts prove process
   continuity.
2. Deliberate native-checkpoint loss, replacement-compute workspace restoration,
   and deployed multi-agent capacity/interruption cases.
3. Canonical provider/scheduler scenarios, credential refresh/revocation and IAM
   narrowing, webhook retry/fanout, and remaining field/Item/limit comparisons.
4. The caller/grant audit and deployment cutover inventory in
   [the obsolete implementation handoff](obsolete-implementation-removal.md).
   Retained deployment data still needs explicit disposition before deletion.

The stack and original state remain available for those tests. Preserve
`.aws-e2e/oauth260827a` and unrelated resources. No Lambda MicroVM was provisioned
during this EC2 validation cycle; MicroVM and S3 Files support remain.
