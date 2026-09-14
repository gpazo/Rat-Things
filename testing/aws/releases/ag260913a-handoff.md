# Machine handoff: Agents API compatibility

Continue from branch `codex/agents-api-compatibility`. This branch contains the
compatibility audit, credential cleanup and preparation fencing, relay TLS repair,
Session closure/cancellation fixes, and retryable native pre-admission handling.
The full behavior ledger remains open in
[`plans/agents-api-conformance.md`](../../../plans/agents-api-conformance.md).

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
5. After native acceptance and state reconciliation, deploy the remaining local
   lifecycle fixes and verify cancellation/admission, deletion, reconnect and
   recovery against the deployed services. Preserve Lambda MicroVM and S3 Files
   support. Broader provider, scheduler, credential and API behavior cases remain
   listed in the conformance ledger.

## Deployed versus local changes

The previously verified `ag260913a` HTTP and relay services use the immutable
image in `ag260913a-image.json`. Preparation cleanup and the expanded stream filter
were also deployed. The later Session closure/cancellation and native admission
changes are local source changes awaiting deployment. Newly packaged `dist/`
archives must not be mistaken for the currently deployed Lambda code.

The existing long-lived Session soak must be inspected under its original owner:
`sess_a3cf9b41996b45898cf3536ccc9729c6`. Its first Turn was
`turn_b966e063c74e449dbda9bf00b2e3e79c`. A previous read using this machine's API
principal returned 404, but a consistent storage read found the Session under a
different owner. That is not evidence that the soak was deleted or completed.
Recover the original wrapper and final logs before starting a replacement soak.
Checkpoint loss and replacement-worker recovery still need live proof.

The detailed audit at
[`plans/agents-api-audit-2026-09-13.md`](../../../plans/agents-api-audit-2026-09-13.md)
records evidence and limitations. Ignored `.runtime/aws-validation/` backups may
contain private runtime inputs and presigned URLs; transfer them privately only
if needed. They are not included in Git. Native caches, build output and local
test logs are also ignored.
