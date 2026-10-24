# Support and updates

Rat Things is an engineering preview with **no published service-level agreement
(SLA)**. Support terms are set during the paid assessment. Response targets,
coverage hours and time zone, covered components, reporting channels, escalation
contacts and patch cadence are agreed for the deployment. **Response times remain
unset until that agreement.** This page establishes no availability, response or
resolution commitment.

The assessment also assigns responsibility for preparing and delivering patches,
applying updates, choosing maintenance windows and handling rollback. There is no
published release cadence. Operators apply updates through the existing
[deployment procedures](development-and-deployment.md) and
[local runtime setup](local-workspace.md#give-your-session-a-linux-workspace).

An update should identify the reviewed repository revision and the matching
complete runtime artifacts for the target platform. Codex source, ordered patches,
companion packages and file inventories are pinned together. Keep the artifact
manifest with its runtime directory; replacing only the Codex executable with an
unrelated upstream release is not a supported upgrade. Artifact verification
checks identity and file integrity; it does not establish a signature or prove
runtime behavior. The [runtime maintenance guide](../runtime/codex/README.md)
defines the compatibility and platform acceptance requirements before promotion.

Keep the previous verified revision, complete runtime artifact and worker image
available until the replacement is accepted. Rollback must restore matching
components together and account for durable-state compatibility. Preserve Session
storage and withhold rollback when compatibility is unknown. The
[rollback guide](runbook.md#rollback) describes the deployment boundaries; retention
settings are separate from a backup policy.

For an investigation, use the [operational runbook](runbook.md#first-response) to
identify the deployment revision, platform, affected Session or Turn, and bounded
error details. Keep credentials, prompts, repository contents, signed URLs and full
model event streams out of support messages. The reporting and escalation path is
the one agreed during the assessment.
