# Existing deployment image handoff

`ag260913a-image.json` contains the immutable `environment_relay_image` input for
both the Agents HTTP and environment relay services and the `ec2_worker_image`
input for dedicated workers in `ag260913a` (`us-west-2`).
It also retains the opt-in AWS validation observer and its digest-pinned client
image. The observer task definition does not automatically start a test. Use the
recorded one-off task for an active soak; do not restart the HTTP services or
destroy the stack until that test completes and its fixture cleanup is checked.
It is a Terraform JSON variable file, not a state file or a complete set of
provisioning inputs.

The original `.aws-e2e/ag260913a/` directory, including Terraform state and
`runtime.env`, is on the ARM64 validation machine. Preserve that directory. Use
this image value with its existing saved deployment inputs when reviewing the
next Terraform plan; do not initialize a replacement empty state against those
resources. The source stream filter includes both `session_tool_attempts` and
`session_preparations`.

The current changes include Session preparation and credential cleanup in the
API, control Lambda and outbox consumer, plus the file-only helper's disabled
plugin synchronization and the native TLS root bundle exported from the pinned
Node image. Roll back producers only while retaining the newer
outbox consumer/filter until pending cleanup work has drained. Older producers
without the preparation fence must not be restored while expirable unfinished
preparations exist. Inspect and resolve those records first.

`plans/agents-api-audit-2026-09-13.md` records validation scope and remaining
limitations. Ignored rollout backups and fixture reports are under
`.runtime/aws-validation/`; copy them with the machine handoff if needed. The
native runtime artifact remains a separate build input. Existing Lambda MicroVM
and S3 Files configuration is unchanged. The resumed state reconciliation and
live results are in `plans/aws-live-resume-2026-09-14.md`.
