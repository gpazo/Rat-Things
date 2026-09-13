# AWS live cycle preparation

This is a contributor handoff for the migration, not live validation evidence.
The live cycle is now in progress; see [`aws-live-validation.md`](aws-live-validation.md)
for its deployment identity, findings and results.

The local release gates below have passed. The verified Linux artifact is in
`.runtime/codex/linux-arm64`, packaged deployment inputs are in `dist/`, and both
ARM64 worker and HTTP/relay images are available locally. Exact hashes and results
are recorded in [`agents-api-validation.md`](agents-api-validation.md). Start the
isolated live cycle from these accepted inputs; deployed parity remains unproven.

## Local release gates

- Exact patched native source, complete companion package and artifact checksums.
- Strict native fixtures on macOS and inside the Linux ARM64 worker image.
- Full repository check, local smoke, console, LocalStack and image isolation/browser checks.
- Review unresolved behavior in `agents-api-conformance.md`; live-only acceptance
  rows remain open until their AWS scenarios pass.

## Inputs identified by read-only inspection

- Prior disposable setup used account `731841023867`, region `us-west-2` and
  model `openai.gpt-5.6-terra`. Reconfirm caller identity and model admission for the
  new cycle; do not infer permission or retained resources from that old setup.
- The current public AL2023 ARM64 SSM parameter resolves to
  `ami-03276ef3c357204ce`. Resolve and inspect again at deployment time, then pin
  the chosen AMI in the test inputs.
- Available public hosted zones include `dev.indubitably.ai` and `indubitably.dev`.
  The user has been asked which development domain to use; preparation defaults
  to an isolated hostname below `dev.indubitably.ai` if no preference arrives.
- No issued regional ACM certificates or Rat Things ECR repositories were listed
  in `us-west-2`. Their creation/publishing is part of the later live setup.

## Deployment preparation after local acceptance

1. Select a fresh disposable deployment ID and preserve its account/region record
   and Terraform state. Do not reuse the retained `oauth260827a` installation.
2. Create the deployment-owned image repository and TLS certificate/DNS validation
   records. Track these resources for teardown; do not overwrite an existing API
   hostname. Use a certificate in the deployment region for direct ALB TLS.
3. Publish the accepted HTTP/relay and worker images as ARM64 images with immutable
   digests. If code or build inputs change, rebuild from `relay/Dockerfile` and the
   verified `microvm-source.zip` and repeat the affected local gates first.
4. Set `AWS_E2E_ENABLE_EC2_WORKER=true`, the pinned AMI and worker image, and all three
   dedicated HTTPS image/hostname/certificate inputs. Set
   `AWS_E2E_ENABLE_MICROVM=false` for the EC2-only acceptance cycle.
5. Apply the isolated test stack, point its chosen hostname at the output ALB DNS
   name, and verify the TLS and discovery endpoints before sending Session input.
6. Run the canonical API, dedicated HTTPS transport, managed Session and console canaries.
   Include `AWS_E2E_LARGE_FILE_MIB=512` for the maximum Files upload; the ordinary
   transport case uses 8 MiB. The disconnected environment case must return its API
   timeout after five minutes while SSE remains connected. Use the existing
   account-scoped AWS credentials and the explicitly admitted model. Never replace
   the requested model identifier to make a test pass.
7. Run the managed Session soak with `AWS_E2E_SOAK_SECONDS=28860`. The process test
   keeps a Codex command session alive across Turns and verifies its in-memory nonce
   and elapsed time. A detached child PID is not a valid cross-sandbox identity.
8. Execute provider/schedule/recovery/credential/webhook and large-transfer cases
   from `obsolete-implementation-removal.md`. External provider message sends need
   their explicit scenario authorization; API/internal fixtures do not authorize them.
9. Delete disposable Sessions, verify workers retire, destroy the test stack and
   image/DNS/certificate setup, and retain diagnostic evidence. The teardown helper
   checks account/region and exact worker deployment/template identity. Preserve
   unrelated deployments, production data and credentials.

The full API acceptance endpoint is the dedicated HTTPS service. Lambda URL smoke
coverage alone cannot establish maximum upload size or long-lived streaming behavior.
