# AWS infrastructure

This Terraform root deploys the Rat Things control plane and configured execution backends. One-shot VMs are
terminated; Session harnesses use a bounded lifetime and an idle policy. Individual
MicroVM instances are managed through the service API; they are not Terraform resources.

The reusable implementation is in `modules/agent-runner`. This root configures the standard AWS
provider and the AWS Cloud Control provider required for the MicroVM image resource.

## What it creates

- HTTP API Gateway with public provider-authenticated webhook routes, public machine-readable
  discovery/contracts, and IAM-authenticated owner-scoped control routes.
- Lambda ingress, control, Agents API/token issuance, Agents outbox, dispatcher, reconciler,
  Session scheduling, connection-health, state-stream, and notification functions.
- Encrypted DynamoDB Agent, Session, execution and integration stores;
  encrypted S3 artifact, non-expiring definition, and MicroVM-source buckets; and encrypted SQS
  work/dead-letter queues.
- A custom EventBridge bus, an EventBridge Scheduler group with a fixed Session-schedule target and invocation
  role, terminal-state notifier targets, failure queues, and alarms.
- A Lambda MicroVM image built from `dist/microvm-source.zip`, its execution/build roles, log group,
  and SSM image metadata.
- When enabled, one private-S3 CloudFront distribution with wildcard publication isolation, signed
  entry URLs and cookies, response hardening, and optional Route 53 aliases for file, site, and
  video sharing.

The module creates an ECR repository for the HTTP/relay image. Setting
`environment_relay_image` enables dedicated Agents HTTP and relay Fargate services, an ECS
cluster, load balancer, CloudFront relay distribution and transport VPC. EC2 workers and
their AMI pipeline are separate opt-ins.

MicroVM runs use a runtime VPC connector and private AWS endpoints even without
S3 Files. Public runtime HTTPS egress requires explicit destination CIDRs; only
that opt-in creates a NAT route. Image builds use separate AWS-managed networking.
S3 Files adds persistent Session storage to the runtime network. These resources
do not connect workers to an existing application VPC.

## Package, validate, and deploy

Use Terraform 1.16.6, pinned in `.terraform-version` and matching CI and the LocalStack
container. The module requires Terraform 1.9 or newer within the 1.x series because
checkpoint validation refers to another input variable.

On macOS, use the official HashiCorp Homebrew tap:

```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
terraform version
```

For an existing installation, use `brew upgrade hashicorp/tap/terraform`. Version
managers that support `.terraform-version` can select the repository's exact pin.

```bash
npm ci
npm run package
terraform -chdir=infra init
terraform -chdir=infra fmt -recursive -check
terraform -chdir=infra validate
cp infra/terraform.tfvars.example infra/terraform.tfvars
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Build or import the patched Linux ARM64 native artifact before running `npm run package`;
see the [runtime build instructions](../testing/README.md#agents-api-native-compatibility-gate).
Packaging verifies the artifact and produces the Lambda ZIPs and `dist/microvm-source.zip`. Configure a remote, locked
Terraform backend before sharing an environment. Pin a currently `AVAILABLE` managed base-image
version rather than relying on an implicit latest version.

Deployed Sessions use Codex by default and can select Pi when its Bedrock catalog is configured. Sessions invoke the configured model when input
arrives. `npm run smoke:local` uses a deterministic mock without provisioning or model calls.
See [development and deployment](../docs/development-and-deployment.md) for configuration.

Publication delivery is optional and requires a separate registrable wildcard user-content domain,
a matching CloudFront certificate in `us-east-1`, an RSA public key, and the matching private key in
Secrets Manager. See [publications](../docs/publications.md#aws-setup) for the complete setup and
security model. The module output `publication_delivery` reports the distribution and DNS state.

## Credentials and network behavior

Terraform accepts Secrets Manager **ARNs**, never secret values. Separate clone and notification
ARNs keep repository-read authority independent from comment-posting authority. The older combined
GitHub/GitLab token inputs are migration aliases only.

Self-hosted OAuth is optional. Apply the stack once, register the `oauth_callback_url` output with
the provider, and create one Secrets Manager JSON secret per configured plugin containing
`client_id` and `client_secret`. Set `integration_oauth_app_secret_arns` to those ARNs and apply
again. The control Lambda receives read access only to the declared app secrets; the worker uses the
same declared list only when refreshing an expiring connection. Provider tokens stay in separate
per-owner connection secrets. See [integrations](../docs/plugins.md#self-hosted-oauth-installation).
Providers may issue more than one independently expiring token family. The built-in Slack flow keeps
its bot and delegated-user access/refresh/expiry fields in that single owner secret and refreshes
each family separately; Terraform still receives only the application-secret ARN.

The trusted root process resolves configured secrets. Agent subprocesses do not inherit the
MicroVM AWS credential chain unless `allow_agent_aws_credential_chain=true` is explicitly set. The
explicitly configured ChatGPT path reads the secret selected by `codex_auth_file_secret_arn`, validates its
file-based login, writes a mode-`0600` runtime `auth.json`, persists validated refresh rotation, and
removes the runtime copy at execution cleanup. A connected Session can retain it between
Turns. Never put the value in Terraform, an image, Run, state record, or log. Codex and
repository code run under the same agent UID and can read the active file, so this bridge
is only for trusted owner-operated agents. Theft of its renewable refresh token can
impersonate the Codex login. Validation preserves unknown fields; protect the whole bundle.
Bedrock mode, selected by default by the AWS quickstart, mints a short-term token from the execution role;
`codex_bedrock_model_ids` restricts inference to exact model IDs.
The Agents model catalog is operator-declared rather than inferred from Codex support metadata.
For ChatGPT authentication, set `codex_chatgpt_model_ids` to the exact IDs verified for the
deployment-owned workspace credential. An explicitly pinned `codex_chatgpt_model` supplies a
singleton catalog when that list is empty. Without either setting, model discovery returns unavailable
because the server cannot safely infer account availability from another Codex login.

## Enable Pi inference

Pi Durable is integrated alongside Codex behind the same Session API. Select it
with `metadata.rat_things_runtime = "pi"` or the CLI's `--runtime pi` flag.
See the [runtime comparison](../docs/agent-runtimes.md) and
[Pi setup guide](../guides/run-pi-durable-on-bedrock.md).

Pi Sessions use Bedrock Converse independently of `codex_auth_mode`. Configure
`pi_bedrock_model_ids` with exact supported model IDs and
`pi_bedrock_inference_resource_arns` with the exact resources that the worker may
invoke. Set `pi_bedrock_default_model` to advertise a picker default. It must be
in the model list. An empty list disables Pi. A catalog entry does not grant model access or guarantee
availability in an AWS account or region. Managed Pi environments additionally
require `enable_s3_files` and `session_checkpoints_enabled`.

```hcl
pi_bedrock_model_ids     = ["amazon.nova-micro-v1:0"]
pi_bedrock_default_model = "amazon.nova-micro-v1:0"
pi_bedrock_inference_resource_arns = [
  "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-micro-v1:0",
]
```

For cross-region inference, include the inference profile ARN and foundation
model ARNs in every destination region. Include the account's default project
ARN when the model requires it. Wildcards are rejected. These grants authorize
`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, plus short-term
Bedrock bearer-token use. They do not change Codex Mantle grants or provide AWS
role credentials to the agent process.

The module supplies `PI_BEDROCK_MODEL_IDS_JSON` and
`PI_BEDROCK_DEFAULT_MODEL` to the service and workers. The API intersects configured
IDs with the Pi 1.3.0 Converse catalog in
[`src/adapters/pi-bedrock-models.json`](../src/adapters/pi-bedrock-models.json).
Each entry records exact AWS-documented invocation IDs, its pinned Pi registry
descriptor, supported reasoning efforts, and the AWS model-card source.
Unsupported IDs fail configuration. Catalog
membership does not establish model access, region availability, or capacity.
The deployment must have access to each configured model.

The catalog includes supported Nova, Claude, DeepSeek V3, Llama, MiniMax,
Mistral, Kimi, Nemotron, GPT, Qwen, Palmyra, Grok, and GLM models. Models that
require inference profiles accept only the listed profile IDs. A documented
alias can reuse the recorded descriptor for the same model; arbitrary profile
prefixes and registry labels alone do not admit additional models.

Reasoning choices reflect both Bedrock support and Pi's request adapter.
Anthropic and OpenAI models expose only efforts that pass through without
clamping. Other reasoning models, including Nova 2, use provider-default
reasoning and reject explicit effort settings. Input modalities are limited to
the pinned Pi descriptor's text and image support; audio and video are not
accepted.

## Choose Session execution

MicroVM is the default for new Sessions, including deployments that also enable EC2.
It uses native suspend/resume to preserve memory and disk while the MicroVM remains
available. Conversation age does not select EC2 or trigger a migration.

Use EC2 for a workload that needs the same process to remain alive beyond the eight-hour
MicroVM lifetime. Create a saved Agent for that workload, then list its exact owner and
Agent IDs in deployment configuration:

```hcl
enable_microvm    = true
enable_ec2_worker = true
ec2_session_workloads = [
  { owner_id = "your-api-owner-id", agent_id = "agent_your_long_running_workload" }
]
```

The owner ID must match the authenticated API principal. Create Sessions with that saved
`agent_id` through the existing API. Inline Agents, other owners and unlisted Agents use
MicroVM. Enabling EC2 alone does not route any new Session to it; EC2 still requires its
pinned AMI/image and S3 Files configuration. No new public API fields are required.

Placement is recorded privately during Session preparation and retained for its lifetime.
Changing the workload list affects new Sessions only. A selected backend that is unavailable
returns an error rather than silently using another backend. Existing running workers are
not moved; legacy Sessions without recorded placement default to MicroVM on their next launch.
An EC2-only deployment must explicitly list each workload it admits.

Native MicroVM resume preserves the same machine. With `session_checkpoints_enabled=true`,
S3 Files and the matching native runtime, a committed checkpoint can preserve workspace and
conversation state across a planned replacement or managed fork. Without an adoptable
checkpoint, hosted replacement rebuilds the workspace; retained bytes alone are not a
recovery guarantee. See [Sessions](../docs/conversations.md) for recovery and fork behavior.
There is no automatic MicroVM-to-EC2 migration. The optional AMI pipeline below reduces
EC2 boot work and is not required for MicroVM workloads.

## Prepare an EC2 worker AMI

Cold EC2 workers install Docker and pull `ec2_worker_image` during boot. To move that work into an
AMI, provision the dormant Image Builder pipeline with a pinned ARM64 Amazon Linux 2023 parent AMI,
a digest-pinned worker image, and explicit three-part component and recipe versions:

```hcl
enable_ec2_worker_ami_pipeline   = true
ec2_worker_ami_base_id           = "ami-0123456789abcdef0"
ec2_worker_image                 = "123456789012.dkr.ecr.us-west-2.amazonaws.com/worker@sha256:..."
ec2_worker_ami_component_version = "1.0.0"
ec2_worker_ami_recipe_version    = "1.0.0"
```

Terraform creates no schedule and starts no build. Start one build explicitly:

```bash
PIPELINE_ARN="$(terraform -chdir=infra output -json ec2_worker | jq -r .ami_pipeline_arn)"
BUILD_ARN="$(aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "$PIPELINE_ARN" \
  --query imageBuildVersionArn --output text)"
aws imagebuilder get-image \
  --image-build-version-arn "$BUILD_ARN" \
  --query 'image.{status:state.status,ami:outputResources.amis[0].image}'
```

Repeat `get-image` until `status` is `AVAILABLE`. Record the returned AMI ID. Do not select an image
by name or by creation date. Use the ID in a separate runtime apply:

```hcl
enable_ec2_worker       = true
ec2_worker_prepared_ami = true
ec2_worker_ami_id       = "ami-produced-by-the-build"
```

Prepared boot checks the cached image architecture and exact repository digest. A missing or
mismatched image terminates the dedicated worker. Bump the component version when its commands
change. Bump the recipe version when the parent AMI, component version, or worker digest changes.

Image builds use AWS-managed `INTERNET_EGRESS`. Every runtime launch, including one-shot jobs,
uses the deployment's VPC connector instead. A missing runtime connector fails before launch.
The dispatcher needs `lambda:PassNetworkConnector`; AWS documents no resource type or condition
key for this action, so it remains isolated in a `Resource = "*"` statement.

The default inner sandbox is `workspace-write`, the accepted modes are `read-only` and `workspace-write`,
and agent tool networking defaults off. Managed environments retain workspace-only writes even
when networking is explicitly enabled. Temporary files stay inside the workspace. Pi verifies
sandbox enforcement before exposing managed tools; an unsupported or ignored profile fails startup.
The outer VM and separate agent UID remain independent isolation boundaries.

Runtime egress permits HTTPS to private AWS API endpoints, the S3 and DynamoDB gateway endpoints,
and NFS to the Session mount target. There is no default internet route. PrivateLink endpoints have
recurring AWS charges; review the Terraform plan and regional pricing before installing. Optional
relay endpoints use the same private-service approach, with the load balancer limited to its task
port. Inbound service HTTPS remains available.

To reach repositories, package registries, external MCP servers, OAuth providers or ChatGPT,
configure `runtime_https_egress_cidrs` with their reviewed IPv4 destination ranges. Only TCP 443 is
permitted; unrestricted CIDRs are rejected. This also provisions the workers' NAT route. Keep ranges
current as providers change addresses. The environment's hostname allowlist must separately admit
each tool destination; an agent cannot widen the deployment's network policy. Bedrock inference and
AWS orchestration use private endpoints without an internet exception. System package installation
and optional AMI builds also require reachable repositories; prepare dependencies in the image when
running without public destinations.

Execution admission is limited per authenticated owner, across API instances and restarts.
`owner_rate_limits` defaults to 60 new Sessions, forks, input messages, or standalone jobs
per UTC minute. Configure `default` and an `owners` map to set operator-managed overrides;
zero blocks new admissions for that owner. Existing operation IDs remain idempotent.
Cancellation and reads remain available when the limit is exhausted. Rejections return
HTTP 429 with `Retry-After`. A storage failure denies new work instead of skipping the limit.
Rate limits do not impose a dollar spending cap.

## Optional budget alert

Set this before applying if you want a monthly AWS account spending email:

```hcl
budget_alert = {
  monthly_usd     = 50
  email_addresses = ["you@example.com"]
}
```

Replace the example amount and address. The default is `null`, which creates no
budget. When enabled, the module creates an AWS Budgets `COST` budget in USD with
one actual-spend notification above 100% of the monthly amount. It filters to the
deployment's AWS account across all regions and services, including other workloads
and costs already incurred in the current month. Shared costs are not split by
Rat Things owner. No budget action or execution denial is configured.

The deployment identity needs permission to manage AWS Budgets and its email
notifications. The `budget_alert_name` output identifies the budget; setting the
input back to `null` or destroying the stack removes it. The AWS quickstart exposes
the same option through `--budget-usd` and `--budget-alert-emails`. Local subscription
use requires neither AWS nor a budget. See [costs](../docs/costs.md#optional-budget-alerts)
for delayed billing data and alert scope.

## MicroVM lifecycle

The source bundle starts a root lifecycle server on port 8080 and signals readiness only after its
runtime is initialized. It snapshots no run ID, token, repository, or workspace. Per-run identifiers
arrive in the bounded `/run` payload; the worker retrieves the full request from encrypted S3.

The agent subprocess runs as UID/GID 10001. One-shot jobs call `TerminateMicrovm` when the runner
exits. Session harnesses accept additional Turns through private authenticated control.
The Session runtime journal saves conversation state. Optional S3 Files storage retains
workspace and Codex home bytes where applicable. Codex can adopt a committed checkpoint
when checkpointing is enabled; ordinary replacement rebuilds its workspace. Pi Durable
restores native tasks from the state store, and its managed recovery retains flushed
workspace files after verified termination. Native
MicroVM suspend/resume preserves the existing machine's memory and disk.

The current AWSCC schema requires non-empty `additional_os_capabilities`, and the service currently
accepts only `ALL`. Those capabilities remain inside the MicroVM boundary, but this still requires a
production security review.

## Failure recovery

The `state_stream_failure_queue_url` output identifies exhausted DynamoDB Stream invocations. Retain
the message, use its shard/sequence metadata while the stream record exists, or reconstruct the
bounded event from the durable run record. Verify the downstream delivery fence before deleting the
failure message.

The `notifier_delivery_failure_queue_url` output identifies terminal events EventBridge could not
deliver after its configured retries. Repair the target, redrive each event, verify the
per-destination delivery fence, and only then delete the DLQ message.

The `thing_schedule_failure_queue_url` output identifies EventBridge Scheduler deliveries that
exhausted retries. Inspect the schedule generation, saved occurrence and scheduled time, repair the fixed target
or schedule state, and replay only after confirming the occurrence idempotency key is safe. The
`thing_schedule_group_name` output identifies the deployment-owned group; consumers cannot select
an arbitrary AWS target or IAM role.

Service references:

- <https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html>

## Legacy deployment cutover

This module no longer declares the former Thing, Routine and conversation tables,
conversation queues, or coordinator/completion log groups. Applying it to a stack
that still contains those resources deletes them and their data. Review the plan
before applying to a deployment whose historical data needs preservation.

The S3 Files resources still serve current Sessions. Their historical
`conversation_state` names and `/conversations` access-point root must remain
stable when applying this cutover. Build the control plane and MicroVM image from
the same checkout: the new private launch field is `sessionStorageKey`.
