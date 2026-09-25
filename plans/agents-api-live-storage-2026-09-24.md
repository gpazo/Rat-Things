# AWS storage, concurrency and recovery acceptance

Work branch: `codex/agents-parity-completion`. Deployment: `ag260913a`, account
`731841023867`, region `us-west-2`. The original state remains at
`.aws-e2e/ag260913a/terraform.tfstate`, lineage
`be69a19a-2f46-d753-8dc0-0884b98a7269`. The soak heartbeat remains paused.
All harness, storage, relay and worker infrastructure remains in the operator's
AWS account. This report closes specific acceptance cases, not the entire parity
ledger.

## Accepted storage candidate

Commit `50f7a44` fixes two independently reproduced failures:

- SQLite WAL indexes on shared S3 Files stalled full-history child admission.
  `CODEX_SQLITE_HOME` now selects a local ephemeral mount. Native rollout journals
  remain durable. The native recovery fixture deletes the old SQLite directory,
  resumes the same thread using a fresh directory and preserves history without
  extra inference.
- Concurrent Session observation writes produced confirmed aborted DynamoDB
  `TransactionConflict` cancellations. The adapter now reports these as revision
  conflicts so the existing source-revision checks can safely retry. Unknown,
  mixed validation and ambiguous acknowledgement failures are not replayed.

The accepted worker image is
`accepted-worker@sha256:957c0fda8829fe395f8ce1c67cc9b33d395fc4aae95fdad106c6129fe5850b23`;
the relay/API image is
`accepted-relay@sha256:419325a51b3d6a38ca1be12a559674b09033707a767ca6a7871b18d38bd9a671`.
Both repositories are under
`731841023867.dkr.ecr.us-west-2.amazonaws.com/rat-things-ag260913a/`.
Worker launch-template version 9 was verified against that digest. Both ECS
services reached healthy completed deployments. The reviewed full Terraform
plan replaced task-definition revisions only; retained data stores were not
replaced.

Evidence folder: `.aws-e2e/ag260913a/parity-20260923/`.

| Proof | Result | Evidence log |
| --- | --- | --- |
| Repository checks, packaging and Terraform validation | Passed, 1,038 tests and 39 opt-in skips | `storage-contention-check.log` |
| Strict ARM64 native image | Passed, 369 tests | `storage-native-image.log` |
| Worker isolation, networking, Chromium and VP8 recording | Passed | `storage-worker-canary.log` |
| Capacity 6, overflow denial, three interrupted follow-ups, final child completion | Passed, 542 seconds | `live-multi-agent-storage-fix.log` |
| Capacity 1 with the same interruption sequence | Passed, 181 seconds; overlapped the outbox retry rollout | `live-multi-agent-one-storage-fix.log` |
| Function-wait cancellation, SSE reconnect and follow-up | Passed, 105 seconds | `live-recovery-storage-fix.log` |
| Harness-only worker replacement with saved native history | Passed, 190 seconds | `live-recovery-storage-fix.log` |
| Hosted worker replacement, fresh workspace, retained artifact/context and one reset event | Passed, 199 seconds | `live-recovery-storage-fix.log` |
| Hosted replacement with intentionally absent native checkpoint | Passed, 446 seconds including complete termination of the original worker | `live-recovery-storage-fix.log` |

## Outbox follow-up

The six-child run exposed a six-minute FIFO visibility delay after a rejected
storage write. Commit `48de5d4` adds a typed storage-conflict error and selects a
five-second retry only for that error. Generic lifecycle and idempotency 409s
retain their existing handling. The local boundary test verifies failure is not
acknowledged, SQS visibility is shortened, and successful redelivery is then
acknowledged. The full repository check passed 1,040 tests and 39 opt-in skips.

The reviewed targeted plan changed only `agents-outbox`. Its deployed package
SHA-256 was verified as
`5083e7f8d1b99faeae2fc45f7c14a006b6e878676f75c0e3e7f3e3803c0ab50b`.
A fresh capacity-6 proof passed in 208 seconds with the same assertions;
see `live-multi-agent-outbox-fix.log`. Both commits passed CI. Diagnostic images
were excluded from these acceptance results.

The tests deleted their Sessions and Agents. A scoped read afterward found no
running or pending deployment worker. Earlier orphaned diagnostic workers were
terminated only after matching deployment/Run tags and confirming absent or
terminal Run records. Retained data and unrelated deployments were not removed.

## Typed content candidate

Commit `fcde56d` preserves the native v2 encrypted/plaintext distinction for
collaboration calls. The [Item audit](agents-api-item-event-audit-2026-09-14.md)
records the source contract and focused regressions. Repository checks passed
1,044 tests with 39 opt-in skips before the new provider canary was added; the
new four-case canary separately passed type checking and remained skipped without
its live opt-in. Strict ARM64 native acceptance passed 374 tests, and the worker
isolation/browser canary passed again.

The typed-content worker is
`accepted-worker@sha256:364f90d0b1b80c02a961932d46f9a4bf4b944cddade9c20d20f1c89baae53bca`;
the typed-content relay/API image is
`accepted-relay@sha256:177904d82fa8a15b48c720f63e1bcf444990bb964de06556607395bd07fbc86f`.
The full deployment completed with worker launch-template version 10 and healthy
ECS services (API task 18, relay task 16). CI for `fcde56d` passed.
Earlier recovery results above remain tied to the storage candidate.

| Proof | Result | Evidence log |
| --- | --- | --- |
| Capacities 1 and 6 with typed sender/recipient content, overflow, interruption and final child output | Both passed, 176 and 207 seconds | `live-multi-agent-content.log` |
| OpenAI documentation MCP, service and hosted-environment origins | Both passed, 102 and 103 seconds | `live-public-mcp.log` |
| Direct and programmatic function required actions and retained results | Both passed, 103 and 99 seconds | `live-provider-tools.log` |
| Deferred function discovery | Failed: the model finished without a required action | `live-provider-tools.log` |
| Live web search | Failed during native initialization before inference | `live-provider-tools.log` |

## Provider configuration follow-up

Both failures reproduced locally. Public nullable web-search fields were emitted
as explicit null native configuration values, which the harness rejects. The
launch planner now omits absent optional values, including null location fields.
Three real native initialization regressions cover omitted settings, allowed
domains only, and a country-only location.

The Bedrock provider was selected at `thread/start`, after the process had already
created its model catalog. This left the admitted Bedrock model without search
and verbosity capabilities. Selecting the provider at process startup restores
the actual Bedrock catalog. The native request fixture now checks programmatic
and deferred calls through both a generic Responses provider and the built-in
Bedrock provider, including presence of the discovery tool before returning a
synthetic tool-search call. Neither model substitution nor fake parsing of text
as tool calls is used. Commit `c2c6e34` contains these corrections. The full check passes 1,049 tests
with 45 opt-in skips, packaging and Terraform validation. Strict ARM64 native
acceptance passes 379 cases, and the worker isolation/browser/VP8 canary passes.
The new worker digest is
`accepted-worker@sha256:fe22610f31a45df628667d3b26d4982dffe2c6cac1ab3663ece96f3f0f94b136`.
The relay/API digest remains the typed-content digest above. The reviewed full
plan changes the worker launch template and dependent execution configuration;
only the API task definition is replaced, with no retained data-store changes.
Deployment completed with worker launch-template version 11 and API task 19;
both ECS services are healthy. CI run `36084255702` passed. The exact worker
image passes all 379 native cases. Live results:

| Proof | Result | Evidence log |
| --- | --- | --- |
| Direct, programmatic and deferred function round trips | All passed, 106/98/101 seconds | `live-provider-config.log` |
| Web search public call/result | Execution passed; first cleanup hit a retryable storage conflict | `live-provider-config.log` |
| Web search repeated with ordinary SDK cleanup retries | Passed including cleanup, 96 seconds | `live-web-search-provider-config-retry.log` |
| Capacities 1 and 6 with typed content, overflow and three interrupted follow-ups | Both passed, 181/216 seconds | `live-multi-agent-provider-config.log` |
| Real OpenAI documentation MCP, service/environment origins | Both passed, 105/108 seconds | `live-public-mcp-provider-config.log` |

The first web-search Session was explicitly deleted and 404-verified after its
cleanup conflict. Only Session deletion in the provider canary now uses ordinary
SDK retries; its assertions and model operations still run without retries.
These results close the two reproduced provider-configuration failures, not the
full provider matrix or overall parity ledger.

The failed web-search proof left one diagnostic worker running after its Run was
terminal. Its deployment, exact Run and template tags were checked before scoped
termination. This is not evidence that automatic cleanup of every initialization
failure works; that lifecycle path remains an explicit follow-up.


## File and artifact boundary follow-up

The official files guide specifies 50 input files, 5 MiB inline per file,
10 MiB inline total, 50 MiB for Files API copies, 200 MiB per artifact and
500 MiB for outputs published together. Local tests now exercise those exact
boundaries and one-byte/count overflows, plus empty artifacts and file-version
changes during capture. The actual 500 MiB capture test reads all bytes in 1 MiB
chunks and verifies the immutable saved snapshot is reused.

The valid 5 MiB inline case reproduced a V8 regular-expression stack overflow
in `decodeBase64`. Replacing its repeated-group expression with a flat alphabet
check retains canonical decode/re-encode verification, including padding checks.
Commit `0682e6c` contains the correction. Full repository checks pass 1,074
tests with 46 opt-in skips; the exact ARM64 image passes 404 strict native cases.
The opt-in AWS file-boundary canary prepares 50 files with 10 MiB inline data,
copies a 50 MiB Files API input, creates three artifacts totaling 500 MiB,
downloads and hashes each, and verifies
artifact deletion leaves the environment file intact. The exact deployed proof passed
in 570 seconds on worker template 12 after both ECS services stabilized. Session
`sess_ec280873cc42451aba1d5b8280c987da` downloaded and hash-verified all
524,288,000 bytes. Its 50 inputs included two 5 MiB inline files, 47 empty files
and a 50 MiB Files API copy. Artifact deletion preserved the 200 MiB workspace
file. Session, Agent and uploaded File cleanup completed; the deployment had no
running or pending workers afterward. Evidence: `live-file-boundaries.log`. Worker and relay digests are respectively
`b5051b0b1f6624bc86ebdd777bf870b1b272adc2a7c74bb94e3298989cbc756b` and
`11fe6ccc05d48994ec652edb8b89f57c9ec57f48cfed4da0e40ec7d7bcf9bb91`. No provider/model selection changes are part of this follow-up.

## September 25 worker-retirement and Subagent follow-up

A new opt-in failure canary reproduced the retirement gap on `0682e6c`.
Session `sess_b018b9ce86054bbe868e8866ff3a4bd1` failed its deliberate
`exit 73` hosted setup command. Run `c3a94d45-2e98-5a54-92a0-fbdf3cf45c50`
was durably failed, but worker `i-0368f5d444390a987` remained running through
the six-minute retirement deadline. The fixture verified deployment, template,
Run and generation before manual termination. This was a failed proof, not a
passing cleanup test. The console confirms lifecycle shutdown and runner exit;
it does not establish which remaining process or mount delayed host retirement.
Evidence: `live-worker-retirement.log`, `setup-failure-worker-console.json`.

The scheduled reconciler now inventories only this deployment's dedicated EC2
template and checks each candidate against a strongly consistent Run read.
It retires exact terminal attachments after a two-minute grace period, without
relying on guest shutdown. Missing, active, recent or mismatched authority is
preserved. Existing scoped IAM covers these operations. Eighteen targeted tests
cover the decision boundaries, inventory pagination, identity checks and retry
after termination failure. Subagent initial-task typing and creator preservation
are also corrected; 405 strict native cases pass. Full repository validation
passes 1,093 tests with 47 opt-in skips. Commit `a766b7a` was deployed through
the original state (same lineage, serial 598). Worker template 13 contains
`83e2f70c3ffdf6be5bc7a360e8cb6628ca2527dd2d6f45a0d09281e937c73af0`;
API task 21 and relay task 18 contain
`29ba2c2cd9e1c97a9371fcb4cd000a1218cbe1329793e7c42b43ee59a30d0593`.
Both ECS rollouts completed, and the deployed reconciler archive hash matches
`dist/reconciler.zip`. The exact worker image passes 405 strict native cases.
The live retirement proof passed in 524 seconds: Session
`sess_3083241141c9439b899d9425fcabd05a`, Run
`110ca0e7-ded2-5bcb-bd22-043bad6e202d`, worker `i-0139578516718b416`.
The durable Run and public Session both failed as expected. The reconciler
reported `TerminalWorkersRetired=1` at 02:58:56 UTC after the two-minute grace;
the test waited for EC2 `terminated` before deleting the Session. No manual
termination was used. Evidence: `live-worker-retirement-fixed.log`,
`retirement-reconciler-metrics.json`. CI `36087717512` passed.

Capacity 1 passed in 178 seconds on Session
`sess_dbe936ce8940472e8c75553407ab031d`, including typed initial instructions
and preserved origin across three interrupted follow-ups. Capacity 6 on
`sess_bdbc0aa90e7346799c5f4d9eec825ac9` passed creation/typed initial tasks
but the model declined the UUID target for interruption, explaining that native
controls use names. This is not a passing capacity-6 repeat. At the user's
wrap-up request the test was stopped, its Session and Agent deleted, and Session
404 verified. No pending/running deployment workers remained. The exact
remaining work is frozen in `agents-api-closeout-2026-09-25.md`.

An exploratory native v1 close/resume extension found no close Item after its
scripted call. Its cause remains unverified; the extension was removed from the
accepted suite and preserved as a bounded follow-up. The prior 405 passing cases
are not claimed as evidence for this extra scenario.
