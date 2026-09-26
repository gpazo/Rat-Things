# Machine handoff: Agents API compatibility

Continue from branch `codex/agents-parity-completion`. The latest deployment and
acceptance status is recorded in
[`the September 23 continuation`](../../../plans/agents-api-parity-2026-09-23.md).
Preserve the original state, runtime inputs and ignored evidence. The historical
handoff below describes earlier candidates and does not certify the latest images.

The original compatibility branch contains the
compatibility audit, credential cleanup and preparation fencing, relay TLS repair,
Session closure/cancellation fixes, and retryable native pre-admission handling.
The full behavior ledger remains open in
[`plans/agents-api-conformance.md`](../../../plans/agents-api-conformance.md).
The state-owning ARM64 machine has resumed this handoff. Consult
[`the resumed validation report`](../../../plans/aws-live-resume-2026-09-14.md)
for current images, reconciled state and actual results before repeating phases.
The [observer continuation](../../../plans/aws-live-observer-2026-09-14.md)
records the completed cloud-hosted soak. The September 14 17:17 UTC heartbeat
observed the Agents outbox and all seven checked failure queues empty. The
observer then exited zero after the full 29,100-second Session soak, both streamed
Turn completions, managed proof assertions, and 404 cleanup checks for its Session
and Agent. No deployment worker remains. Check the continuation before restarting
API services; the stack and Terraform state are preserved.

## Resume on the machine with state and ARM64 support

1. Fetch the branch and switch to it after preserving any local modifications.
   Keep the original `.aws-e2e/ag260913a/` directory, including Terraform state,
   `runtime.env`, deployment inputs and original soak logs. Git does not transfer
   any of those ignored files.
2. Run `npm ci`. Reuse the matching Linux ARM64 runtime export already on that
   machine, or follow the native build/export instructions in
   [`testing/README.md`](../../README.md). Keep `artifact.json` and `runtime/`
   together. `CODEX_RUNTIME_ARTIFACT` selects the export; packaging validates it.
   The separate `../codex` checkout was not modified. The required upstream
   revision and patches are defined by `runtime/codex/source.json`.
3. Run `npm run check`, then `npm run test:infra`,
   `npm run test:e2e:relay-image`, `npm run test:e2e:microvm-image`,
   `npm run test:e2e:native-image`, and the LocalStack and console workflows.
   These checks do not provision live Lambda MicroVMs. Live provisioning remains
   explicit opt-in. CI currently runs on pull requests and pushes to `main`;
   pushing this handoff branch alone does not start its ARM64 job.
4. Review the existing deployment's Terraform plan with its original state and
   saved inputs, incorporating the image input in
   [`ag260913a-image.json`](ag260913a-image.json). Read the rollback constraints in
   [`README.md`](README.md). Do not recreate empty state for the existing resources.
   This harness uses an explicit local state path: include `-state="$state_file"`
   in both plan and saved-plan apply commands.
5. After native acceptance and state reconciliation, deploy the remaining local
   lifecycle fixes and verify cancellation/admission, deletion, reconnect and
   recovery against the deployed services. Preserve Lambda MicroVM and S3 Files
   support. Broader provider, scheduler, credential and API behavior cases remain
   listed in the conformance ledger.

## Deployed versus local changes

The `ag260913a` HTTP/relay services and dedicated workers use the immutable
inputs in `ag260913a-image.json`. Preparation cleanup, the expanded stream filter,
Session closure/cancellation and native admission changes have been deployed
through the original Terraform state. The resumed cycle also fixes conflicting
input writes and attribution of a stopped harness to newly queued input. Newly
packaged `dist/` archives must not be mistaken for deployed
Lambda code; compare their hashes and the actual task image digests.

The original long-lived Session soak ran under its original owner:
`sess_a3cf9b41996b45898cf3536ccc9729c6`. Its first Turn was
`turn_b966e063c74e449dbda9bf00b2e3e79c`. Its final logs are now recovered: the
second SSE completion assertion failed, and teardown stopped before Terraform
on an AWS signature-expiry error. Both Turns completed, the Session was deleted,
and hash-verified artifacts establish the same process survived 29,395 seconds.
That evidence does not turn the failed stream assertion into a passing soak.
Checkpoint loss, replacement compute and harness recovery are separate cases;
use the resumed report rather than inferring their result from a completed Turn.

The detailed audit at
[`plans/agents-api-audit-2026-09-13.md`](../../../plans/agents-api-audit-2026-09-13.md)
records evidence and limitations. Ignored `.runtime/aws-validation/` backups may
contain private runtime inputs and presigned URLs; transfer them privately only
if needed. They are not included in Git. Native caches, build output and local
test logs are also ignored.
