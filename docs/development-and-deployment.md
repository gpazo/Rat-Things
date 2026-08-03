# Development, deployment, and migration

## Prerequisites

- Node.js 20 or newer and npm.
- Git.
- Terraform 1.5 or newer.
- AWS CLI v2 credentials for the target account/Region.
- Docker with `buildx` and ARM64 image support for ECS worker builds.
- An installed/authenticated Codex CLI for real Codex local tests. The worker image installs the
  pinned CLI version itself.
- For Lambda MicroVMs, an eligible AWS Region, the AWS Cloud Control provider version pinned by this
  repository, service quotas, and a currently `AVAILABLE` managed base-image version.

Start with ECS and the mock driver. Model credentials, source-control credentials, provider
webhooks, NAT/interface endpoints, and MicroVM provisioning are separate opt-in steps.

## Local workflow

Install exactly the locked dependency graph and run the fast checks:

```bash
npm ci
npm run typecheck
npm test
npm run smoke:local
```

`smoke:local` validates a v1 request and runs the deterministic mock driver in the current directory.
It does not create DynamoDB state, enqueue SQS, launch ECS/MicroVMs, emit EventBridge events, deliver a
notification, or call a model.

To exercise the complete local control/data workflow with disposable LocalStack resources and a
WireMock Teams destination:

```bash
npm run test:e2e:localstack
```

This is a serial, clean-room integration test. It fails if Docker or LocalStack is unavailable rather
than silently skipping. The tested boundary and interactive lifecycle commands are documented in
[`testing/README.md`](../testing/README.md). ECS/Fargate and Lambda MicroVM lifecycle checks remain
live-AWS canaries.

Use the source CLI for focused local runs:

```bash
npx tsx src/cli.ts local --driver mock --prompt "Return the local marker"
npx tsx src/cli.ts local --driver codex --sandbox read-only --prompt "Summarize this repository"
```

`examples/run-request.json` demonstrates the remote schema but contains a deliberately nonexistent
example repository. Copy it and replace the URL/ref before using `--file`; it is not a smoke fixture.

The `execution.backend` field has no effect in `local` mode; it is a remote scheduling choice. A
request containing `repository` clones into a temporary workspace and deletes it on exit. A local
clone credential ARN uses the developer's AWS credential chain to read that exact secret, so test
with a non-production, read-only credential.

Build all Lambda, runner, and CLI bundles; create reproducible Lambda/MicroVM ZIPs; validate Terraform;
and build the local ARM64 worker image with:

```bash
npm run package
npm run terraform:fmt:check
npm run terraform:validate
npm run docker:build
```

The full repository gate is:

```bash
npm run check
```

Ordinary checks package the MicroVM source bundle but must not call AWS or provision a MicroVM.

## Terraform layout

- `infra/modules/agent-runner` is the reusable subsystem module.
- `infra/` is a minimal root deployment using that module.
- Root inputs should contain environment labels, feature flags, resource sizing, image tags, and
  **Secrets Manager ARNs only**. Never put secret values or Workflow URLs in `.tfvars` or Terraform
  state.
- S3/DynamoDB artifacts and state are independent from `indubitably-serverless`; do not point the new
  stack at old tables, queues, buckets, task definitions, or event buses.

Terraform uses both the standard AWS provider and the pinned AWS Cloud Control provider because the
new Lambda MicroVM image/connector resources are exposed through Cloud Control. Keep
`enable_microvm=false` for an ECS-only deployment.

Review paid resources before applying: NAT Gateway, interface VPC endpoints, Fargate tasks, logs,
S3, DynamoDB, model calls, and MicroVM builds/runs all have separate cost surfaces. Private runners
cannot reach GitHub/GitLab or an internet model endpoint unless appropriate egress is enabled.

## Deploy an ECS-first dev stack

### 1. Package and configure

```bash
npm ci
npm run check
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Edit only non-secret values and secret ARNs. For the first infrastructure smoke test, keep:

```hcl
environment                      = "dev"
default_execution_backend        = "ecs"
default_agent_driver             = "mock"
allowed_sandbox_modes            = ["read-only", "workspace-write"]
allow_agent_aws_credential_chain = false
enable_vpc_endpoints             = true
enable_microvm                   = false
force_destroy_data               = false
```

Leave the sandbox policy at `read-only,workspace-write`. `danger-full-access` is rejected by default
and must not be enabled merely to get a failing canary to pass.

The example file contains visibly fake channel secret ARNs. Replace every enabled value with an
existing secret ARN in the target account/Region or comment it out so the nullable default disables
that route. Never apply the placeholders.

The worker uses private subnets with no public IP. Enable **at least one** of `enable_nat_gateway` or
`enable_vpc_endpoints` before expecting ECS to start: even a mock/no-repository task needs ECR API and
registry access plus CloudWatch Logs connectivity (the S3 and DynamoDB gateway endpoints are created
separately). Enable NAT when workers must also clone public GitHub/GitLab repositories or reach a
public model/provider endpoint. Interface endpoints keep supported AWS API traffic private but do
not provide internet egress. Populate `bedrock_model_arns` only with the exact models or inference
profiles the worker may invoke, and account for NAT/interface-endpoint cost in either design.

`ecs_assign_public_ip=true` is the explicit low-cost exception for disposable validation stacks. It
runs workers in the module's public subnets and avoids hourly NAT/interface-endpoint charges. Keep
the default `false` for normal environments where private runner networking is part of the security
boundary.

### Disposable live-AWS gate

Use the dedicated harness instead of the normal dev state when the goal is a brief infrastructure
validation followed by immediate cleanup:

```bash
npm run test:e2e:aws
```

It applies the isolated root under `testing/aws`, pushes a unique worker image, runs real control API
and signed GitHub/GitLab paths with the mock driver, and destroys the resources from an exit trap.
See [`testing/aws/README.md`](../testing/aws/README.md) for the exact validation boundary and the
manual teardown command.

To add a real Lambda MicroVM build/run to the same disposable gate:

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<currently-available-version>" \
npm run test:e2e:aws
```

This mode temporarily enables a NAT gateway for the MicroVM VPC connector. LocalStack cannot replace
this leg because it does not emulate the MicroVM APIs or lifecycle hooks.

### 2. Plan and create the control plane/ECR

```bash
terraform -chdir=infra init
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra validate
terraform -chdir=infra plan -out=dev.tfplan
terraform -chdir=infra apply dev.tfplan
```

Review the plan for the intended AWS account/Region, public webhook routes, IAM pass-role scope,
retention, networking, paid resources, and deletion settings. The ECS task definition may reference
an image tag that has not been pushed yet; no worker starts until a run is dispatched.

### 3. Build and push an immutable ARM64 worker image

Obtain the ECR repository URL from Terraform. Then:

```bash
RUNTIME_ECR_URI="$(terraform -chdir=infra output -raw worker_repository_url)"
RUNTIME_REGISTRY="${RUNTIME_ECR_URI%%/*}"
RUNTIME_IMAGE_TAG="<immutable release or commit identifier>"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$RUNTIME_REGISTRY"
docker buildx build \
  --platform linux/arm64 \
  --tag "$RUNTIME_ECR_URI:$RUNTIME_IMAGE_TAG" \
  --push .
```

Set `worker_image_tag` to that immutable value, review a new Terraform plan, and apply it so the task
definition references the pushed image. Do not overwrite a release tag; a tag change without a task
definition revision makes rollback and incident correlation unreliable.

### 4. Remote infrastructure smoke test

Build the CLI and configure it from Terraform output:

```bash
npm run build
export AGENT_RUNTIME_API_URL="$(terraform -chdir=infra output -raw api_endpoint)"
export AWS_REGION="<stack region>"

node dist/cli.mjs doctor
node dist/cli.mjs submit \
  --driver mock \
  --backend ecs \
  --sandbox read-only \
  --idempotency-key "dev-ecs-smoke-001" \
  --prompt "Return the remote ECS smoke-test marker" \
  --wait \
  --output
```

Remote CLI requests are SigV4-signed for API Gateway with the standard AWS credential chain. The
identity must have `execute-api:Invoke` only for the intended stack/stage. Do not set
`AGENT_RUNTIME_UNSIGNED=true` against a deployed API; that option is only for an isolated local HTTP
facsimile.

Exercise the rest of the control surface:

```bash
node dist/cli.mjs list --limit 10
node dist/cli.mjs get RUN_ID
node dist/cli.mjs artifact RUN_ID events
node dist/cli.mjs cancel RUN_ID
```

Verify DynamoDB/S3 state, exactly one ECS task, worker exit, result checksum/download, EventBridge
terminal state, empty healthy queue, no DLQ item, and expected log correlation. Cancellation needs a
deliberately long test driver/workload; cancelling an already terminal mock run simply returns it.

### 5. Real Codex canary

Only after the mock path passes:

1. Set the default driver or the request driver to `codex`.
2. Prefer a scoped Bedrock API key stored at `bedrock_api_key_secret_arn`; trusted orchestration passes
   only `AWS_BEARER_TOKEN_BEDROCK` to the UID 10001 agent child. Keep
   `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=false`. If the AWS credential-chain escape hatch is explicitly
   accepted for a controlled environment, configure exact `bedrock_model_arns` without expanding the
   task role to unrelated resources.
3. Confirm the worker image's `config/codex.toml` and model/provider match the credential strategy.
4. Enable the minimum egress/VPC endpoints and run a non-sensitive, no-repository prompt.
5. Add one public/read-only repository, then one private repository using a dedicated clone-only
   secret ARN from `worker_secret_arns`.
6. Validate output, events, timeout, cancellation, logs, cost, and that neither task overrides nor
   logs contain the prompt/token.

Codex non-interactive behavior and authentication change over time; verify the pinned CLI against the
official [non-interactive guide](https://developers.openai.com/codex/noninteractive),
[CLI reference](https://developers.openai.com/codex/cli/reference), and
[authentication guide](https://developers.openai.com/codex/auth) before upgrading it.

## Enable Lambda MicroVMs

Lambda MicroVMs are a second backend, not an ECS deployment mode. Keep ECS operational as rollback.

1. Confirm the Region is supported and read the current AWS
   [MicroVM guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html).
2. Package and inspect `dist/microvm-source.zip`. It must not contain `.env`, AWS credentials, provider
   tokens, run data, local workspaces, or unreviewed build output.
3. Find and pin a currently `AVAILABLE` managed base-image version. Never use an implicit “latest”
   snapshot in a release.
4. Enable NAT/runtime egress required by this agent workload and set:

   ```hcl
   enable_microvm             = true
   enable_nat_gateway         = true
   microvm_base_image_version = "<available pinned version>"
   ```

5. Review and apply the Terraform plan. Image build uses the AWS-managed build connector; runtime
   egress uses the stack's VPC connector. These are intentionally different identities/networks.
6. Wait until the image is available and confirm the SSM image/connector parameters hold real ARNs,
   not `UNPROVISIONED`.
7. Submit the exact mock corpus once with `--backend ecs` and once with `--backend microvm`. Compare
   output/checksum, lifecycle logs, timing, cancellation, and cleanup.
8. Run a non-sensitive Codex canary. Do not set the deployment default to MicroVM until the security,
   failure, cost, quota, and parity gates in [the roadmap](status-and-roadmap.md) pass.

AWS documents image construction/lifecycle hooks in
[MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html), runtime launch in
[Launching a MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html), and
connectors in [MicroVM networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).

## Configure webhooks and chat

Enable one adapter at a time by supplying its ingress secret ARN, then follow
[channel configuration](channels.md). Start with a disposable repository/team and inspect provider
delivery history plus CloudWatch correlation.

For parallel/shadow observation, set `default_delivery_destinations="none"` so the new stack does not
post a second result. This suppresses notifier delivery but does **not** suppress agent/model cost;
channel normalizers leave the driver unset and use `default_agent_driver`. Keep that deployment
default at `mock` for token-free infrastructure/webhook canaries, then explicitly switch it when a
real-driver test is intended. Comments/notes require the configured trigger (`@indubitably` by
default), but PR/MR lifecycle events do not. Prefer a dedicated canary repository over duplicating
production deliveries.

Keep each comment trigger non-empty. The adapters mark provider result replies and ignore that marker
plus provider-declared bot authors, preventing ordinary self-trigger loops even when output repeats
the trigger. Validate those controls with live canary payloads, and retain actor, repository,
concurrency, and budget limits because the trigger is not authorization.

For GitHub Enterprise Server or GitLab Self-Managed, configure both the clone hostname in
`allowed_repository_hosts` and its validated `github_api_base_url` or `gitlab_api_base_url`. Leaving
the public default would send source-result delivery to the wrong provider API.

Teams should use the outgoing-webhook/Workflow combination only as a bridge. The production Teams
SDK/Bot gateway is a separate milestone and can reuse the v1 run/execution subsystem.

## Migration from `indubitably-serverless`

The migration does not change the original repository. Do not delete code, import its Terraform
state, repoint its tables/queues, or destroy its worker/webhook resources as part of creating this
subsystem.

### Compatibility boundary

This repository preserves the concept “authenticated webhook -> isolated agent -> provider result,”
not every behavior of the existing application. The v1 runtime does not automatically carry over old
job IDs, tenant/billing/credit logic, repository caches, canonical thread/resume state, mobile
notifications, frontend projections, or old provider-installation token minting. Inventory those
dependencies and either keep them in the original system or design an explicit versioned adapter.

Source, destination, and credential migrations are separate:

- **Source:** move a GitHub/GitLab callback URL or an API caller only after the new ingress identity,
  owner mapping, event filters, and idempotency are validated.
- **Destination:** decide whether results return to the provider thread, a Teams route, Slack, or
  nowhere during shadowing. Do not infer this from the clone credential.
- **Credential:** create new least-privileged secrets/roles where possible. Temporary reuse means
  granting a new principal to the old secret and must be reviewed independently; never copy plaintext
  into `.tfvars`.

Use the split GitHub/GitLab clone and notification token ARN inputs. The combined token variables are
deprecated compatibility fallbacks; leave them null in the new stack so migration does not collapse
credential identities.

### Staged cutover

1. **Inventory:** record the old webhook URLs/events, GitHub App/GitLab token behavior, tenant/owner
   mapping, prompts, model settings, retries, notifications, metrics, concurrency, and active runs.
2. **Deploy independently:** create the new dev stack with new resource names/state and mock ECS
   tests. Validate retention and teardown behavior without touching the old stack.
3. **Provider canary:** use a dedicated test repo/project and new webhook secret. Compare normalized
   prompt, checkout SHA/base, output, latency, cost, and duplicate behavior with known fixtures.
4. **Real-driver canary:** use a read-only repository and no outbound delivery, then enable one
   provider result destination. Test signature failure, replay, timeout, cancellation, provider 429,
   and notification ambiguity.
5. **Production side-by-side:** deploy the new production stack but leave old callbacks/callers
   unchanged. Verify account/Region, secrets, image, quotas, dashboards, alarms, runbook, and rollback.
6. **Cut over one source:** change one GitHub/GitLab webhook callback (or one API caller) to the new
   Terraform-reported URL. Do not subscribe both stacks to result-producing events unless duplicate
   model work/comments are explicitly acceptable.
7. **Observe and drain:** let old active runs and their notifications finish in the old subsystem.
   New runs have new IDs/storage and must not be “continued” against old state.
8. **Expand gradually:** move the remaining installations/projects only after the canary SLO window.
   Keep the old stack intact for the agreed rollback period.
9. **Decommission separately:** removal from `indubitably-serverless` is a later, explicit project
   with its own backup, retention, Terraform state, data deletion, and rollback approval. It is not
   performed by this repository's deployment.

### Rollback

Restore the provider callback or caller API base URL to the old stack, stop expanding the canary, and
send new explicit runs to ECS if MicroVM was involved. Preserve both systems' run records and
artifacts. Do not replay the same business event into both stacks without checking for an existing
provider response. Detailed incident steps are in [the runbook](runbook.md).

## Destruction and data retention

Keep `force_destroy_data=false` outside disposable development, but do not mistake it for a global
deletion lock: it prevents Terraform from deleting a non-empty artifact bucket or ECR repository; it
does not protect the DynamoDB run table, queues, log groups, or KMS key from an approved destroy.
Apply organization policy/backups and, where required, a reviewed wrapper/module with lifecycle or
service deletion protection for those resources. Before a planned destroy, export the Terraform
outputs, confirm the exact account/Region/workspace and resource prefix, inspect the full destroy
plan, stop webhook/API traffic, drain or cancel active runs, reconcile notification outcomes, and
apply the documented retention/legal policy.

Terraform destruction of compute does not retract provider posts. DynamoDB TTL is asynchronous and
S3 lifecycle is independent; confirm both before claiming data is gone. Never use a broad recursive
delete or Terraform state surgery as a convenience teardown.
