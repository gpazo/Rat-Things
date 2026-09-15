# AWS-hosted soak observer

This continues [the resumed validation cycle](aws-live-resume-2026-09-14.md) on
`ag260913a`, account `731841023867`, region `us-west-2`. Existing API and worker
images stay unchanged. The original Terraform state and all retained storage
remain in place; the observer is additional disposable test infrastructure.

## Findings and correction

The old outbox inventory of 43 visible/16 in-flight messages fell to 26/13 without
purging. The failure queue remained empty. Final drain remains to be confirmed;
preparation-reconciliation waits can retain FIFO heads for up to an hour.

The Mac power log records 19 sleep entries during the original soak, starting
with clamshell sleep at 20:17:30 PDT on September 13. Only 257 minute polls were
recorded, with countdown gaps as large as 1,352 seconds. This establishes a
client-host interruption; it does not identify the exact packet or server event
that ended streaming. The original failed SSE assertion remains failed, while
the previously recovered process-continuity artifacts remain valid. Private
evidence: `resume-soak-sleep-evidence.json` and `resume-power-log.txt`.

The test previously recognized thrown stream errors but ignored an unexpected
clean end. Its new stream monitor retains that failure, checks it during the
idle interval, and records completion/tick timestamps and fixture resource IDs.
Four tests cover clean end, explicit transport error, intentional cancellation,
and an undefined rejection. No reconnection is hidden inside the uninterrupted
stream test. The upstream [reconnection procedure](https://developers.openai.com/api/docs/guides/agents-api/sessions/events#how-to-recover-a-disconnected-stream)
uses a new subscription and saved state because missed events are not replayed;
that remains a separate acceptance case.

## Observer boundary and deployment

The opt-in Fargate observer runs only the trusted SDK client, as UID 1000. The
actual agent still executes on the existing isolated EC2 worker as UID 10001.
The observer has no inbound rules and permits outbound HTTPS. Its task role can
invoke only the deployment's IAM-authenticated token issuer; the separate ECS
execution role pulls the exact repository and writes its log group. No Mac AWS
credentials, model credentials or runtime environment file is copied into its
image or task overrides. It uses rotating AWS task credentials.

Terraform first added seven observer resources with no existing-resource changes,
then added its task definition and set its disposable ECR repository to remove
images on an explicitly requested destroy. No task starts from Terraform or an
ordinary test. The launch helper checks account/deployment, refuses an existing
active observer, and records its one-task request and client token before launch.
This machine's AWS CLI 2.13.25 rejected the token parameter before dispatch; the
helper now uses the matching AWS ECS SDK to preserve idempotent launch retries.
The deployment teardown helper refuses to proceed while an observer is active.
A mocked regression confirms that this refusal happens before credential cleanup,
worker termination or Terraform operations.

Accepted observer image:
`731841023867.dkr.ecr.us-west-2.amazonaws.com/rat-things-ag260913a/validation-observer@sha256:8ad6189f6d4e1b02ae848f4355ed130d0901f6abb34e428564c2725a17a327b8`.
It starts with live tests skipped unless opted in. The final repository check
passes 905 tests with 14 opt-in skips, packaging, site build and all three
Terraform validations (`observer-teardown-check.log`). The subsequently added
teardown regression and four stream-monitor tests also pass, with a clean final
type check (`observer-final-typecheck.log`).

## Live runs

The short AWS-hosted proof passed in 125 seconds and its container exited zero in task
`2eedce5a1d26405c9b6434dfc46ce79b`, using Session
`sess_36e1df4271064aeb85722ff4595fabda`. Its request/response are under
`.aws-e2e/ag260913a/observer-20260914T155935-17510/`.
The log group is `/rat-things/rat-things-ag260913a-observer` and stream
`probe/observer/2eedce5a1d26405c9b6434dfc46ce79b`.
Both completed Turns were received on the original SSE connection. Consistent
DynamoDB reads confirm the Session and Agent are tombstoned; evidence is in
`observer-short-log.json` and `observer-short-cleanup.json`.

The eight-hour-plus run completed in task
`9c484f323d854919b59eb40ab0f0785f`, started September 14 at 16:05:47 UTC and
stopped September 15 at 00:13:34 UTC with container exit code 0.
Its Session is `sess_b74d26ea7a45452581dd78f693a0e1bf` and Agent is
`agent_4fa27408ca2541d596bea7f3edf4e7bc`. Its private launch records are under
`.aws-e2e/ag260913a/observer-20260914T160512-20146/`, and its log stream is
`probe/observer/9c484f323d854919b59eb40ab0f0785f` in the same log group.
It used 29,100 soak seconds; completion finished around 00:15 UTC September 15
(17:15 PDT September 14), after model execution and startup.
The original stream received the first completion,
`turn_45e2cc85524f474fb761b680c23eea06`, at 16:07:49 UTC. It then recorded
healthy idle checks throughout the 29,100-second interval and received the second
stream completion, `turn_43e37584ea044331bb12373bfd35841f`, at 00:13:06 UTC.
The managed-session test passed (`1` file, `1` test), including retained artifact
proofs, same-process continuation, duplicate idempotency receipt, and
guest-boundary assertions. Direct API reads after teardown returned 404 for both
the Session and Agent, and no EC2 instances tagged `RatDeployment=ag260913a`
remain. The observer task itself is stopped; the deployment stack and state remain
intact.

The thread heartbeat `complete-aws-agents-api-soak` checks every 30 minutes when
this host is available. It stays quiet on unchanged progress, collects final
results and cleanup evidence, and pauses after recording the outcome. The AWS
test itself continues even when this Mac sleeps. Do not start a duplicate.

The [parallel local review](agents-api-parallel-review-2026-09-14.md) used the
same branch but was not part of this observer image; the result is acceptance of
the immutable deployed images recorded above. It does not substitute for live
validation of later source changes.

After observer deployment, Terraform reports no drift and the original state
lineage is retained at serial 441 (`observer-final-drift.log`). The most recent
outbox check at 17:17 UTC shows zero visible, in-flight and delayed messages,
down from 22 visible/11 in-flight. All seven checked failure queues also report
zero in every category. This closes the initial residual-drain observation; no
queue was purged. Evidence: `observer-heartbeat-20260914T1717.json`.

The observer heartbeat remains paused as requested after the completed result.
The deployment, original Terraform state, and unrelated
`.aws-e2e/oauth260827a` resources were preserved. Remaining compatibility and
obsolete-code work stays in the existing ledgers.
