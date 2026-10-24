# Machine handoff for ag260913a

This historical handoff identifies the deployment inputs and local evidence to
preserve. It does not establish the current state of the AWS resources.

1. Keep the original `.aws-e2e/ag260913a/` directory, including Terraform state,
   `runtime.env`, deployment inputs and logs. Git does not transfer these ignored
   files. Preserve local modifications before updating the checkout.
2. Run `npm ci`. Reuse a matching Linux ARM64 runtime export or follow the
   [runtime build instructions](../../README.md). Keep `artifact.json` and
   `runtime/` together. `CODEX_RUNTIME_ARTIFACT` selects the export; packaging
   validates its source revision and patches against `runtime/codex/source.json`.
3. Follow the [current contributor verification instructions](../../README.md).
   Live Lambda MicroVM provisioning remains explicit opt-in.
4. Review the existing deployment's Terraform plan with its original state and
   saved inputs, including [ag260913a-image.json](ag260913a-image.json). Read the
   [rollback constraints](README.md). Do not initialize an empty replacement state
   for the existing resources. This harness uses an explicit local state path:
   include `-state="$state_file"` in both plan and saved-plan apply commands.
5. Compare packaged Lambda hashes and actual task image digests before a rollout.
   Local build output does not establish which code is deployed.

Ignored `.runtime/aws-validation/` backups may contain private runtime inputs and
presigned URLs. Transfer them privately when needed. Native caches, build output
and local test logs are also ignored.
