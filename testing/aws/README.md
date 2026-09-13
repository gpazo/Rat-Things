# Live AWS validation

The harness deploys an isolated stack into the caller's AWS account, invokes a
configured model through the Agents API, and tears the stack down. Ordinary
`npm run check` skips it. MicroVM provisioning and model calls require explicit
opt-in:

```bash
AWS_E2E_REAL_CODEX=true AWS_E2E_CODEX_MODEL_ID=YOUR_ADMITTED_MODEL npm run test:e2e:aws
```

The model must be admitted by the stack's configured Bedrock credentials and
region. The wrapper packages Lambda artifacts, deploys the ARM64 MicroVM image,
runs the API and console canaries, terminates remaining MicroVMs and destroys the
isolated stack from its exit trap. Deployment identity and Terraform state live
under `.aws-e2e/DEPLOYMENT_ID/`; recovery verifies the original AWS account.

The API canary uploads and downloads a binary File, checks deletion and rejected
unauthenticated access, then creates an Agent and verifies two completed root
Turns using saved assistant Items. It deletes the disposable Session and Agent.
The console canary creates and continues a Session, reloads saved output and
closes the Session. These are bounded smoke tests, not full deployment conformance.

The managed Session canary checks streamed completion events, input idempotency,
actual command execution, UID 10001, control-port denial, immutable saved artifacts
and continuation of the same command process across two Turns. On EC2 it also
requires IMDS and host-configuration access to be denied. Optional
`AWS_E2E_SOAK_SECONDS=28860` keeps the Session idle beyond eight hours before the
second Turn; this requires `AWS_E2E_ENABLE_EC2_WORKER=true`. The ordinary invocation
does not wait eight hours.

Build and verify the patched Linux ARM64 artifact before packaging (see
`testing/README.md`). EC2 deployment additionally requires an immutable
`AWS_E2E_EC2_WORKER_AMI_ID` and digest-pinned `AWS_E2E_EC2_WORKER_IMAGE`.
Dedicated HTTPS tests require all three inputs:

- `AWS_E2E_ENVIRONMENT_RELAY_IMAGE`: digest-pinned image for HTTP and relay services.
- `AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_HOSTNAME`: owned API origin hostname.
- `AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_CERTIFICATE_ARN`: matching regional ACM certificate.

Point the owned hostname at the `environment_relay_origin_dns_name` Terraform
output before invoking tests. The harness does not create or overwrite that DNS
record. The public Agents URL uses direct ALB TLS; the executor relay uses CloudFront.

The old public Run/conversation, browser takeover, and account-specific demo
canaries are retired. Port provider delivery, environment artifact publication,
schedule overlap, execution-loss recovery, replacement harness and grant-narrowing
scenarios to canonical Sessions before relying on live coverage for those paths.
The exact remaining work is in `plans/obsolete-implementation-removal.md`.

The dedicated HTTPS canaries round-trip an 8 MiB File with an end-to-end checksum and hold
SSE open while a disconnected self-hosted environment reaches its five-minute input deadline.
Set `AWS_E2E_LARGE_FILE_MIB=512` to exercise the maximum Files upload; the default 8 MiB case
only proves a transfer beyond Lambda request limits. These cases run when the dedicated origin
hostname is configured and require the advertised API URL to match it.

The default test deployment uses the Lambda URL Agents transport. Full upload
sizes, long-lived SSE and executor relay coverage require deploying the dedicated
Agents HTTP service; see `docs/agents-api.md`.

Set `AWS_E2E_WEBHOOK_CAPTURE_URL` to the disposable deployment's delivery capture
URL to include the optional webhook case. It registers a Session-created webhook,
checks delivery through `DELIVERY_CAPTURE_QUEUE_URL`, and removes its resources.
Use the deployment-owned capture endpoint; no real provider account is needed.

## Manual phases

```bash
AWS_E2E_REAL_CODEX=true npm run aws:e2e:deploy -- DEPLOYMENT_ID
npm run aws:e2e:test -- DEPLOYMENT_ID
npm run aws:e2e:console:test -- DEPLOYMENT_ID
npm run aws:e2e:status -- DEPLOYMENT_ID
npm run aws:e2e:destroy -- DEPLOYMENT_ID
```

`runtime.env` records the Agents endpoint, control endpoint, region and deployment
identity. Retained installations created before the migration need an explicit
cutover and regenerated runtime configuration. Old provider bindings and schedule
payloads are not reinterpreted as new resources.

The deployment records account/region before apply so partial setup is recoverable.
Teardown verifies that identity, terminates only EC2 workers matching the deployment
and its exact launch template, waits for their termination, and removes runtime
Agents/connection credentials within the disposable deployment prefix. Production
resources and credentials are outside this cleanup.

Docker, AWS credentials, Terraform, an admitted model, ARM64 MicroVM availability
and an opted-in AWS account are prerequisites. LocalStack exercises local
provider/schedule coordination with fake execution; it cannot prove MicroVM or
model behavior.
