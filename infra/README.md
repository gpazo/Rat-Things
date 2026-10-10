# AWS infrastructure

This Terraform root deploys the Rat Things control plane and Lambda MicroVM image. One-shot VMs are
terminated; Session harnesses use a bounded lifetime and an idle policy. Individual
MicroVM instances are managed through the service API; they are not Terraform resources.

The reusable implementation is in `modules/agent-runner`. This root configures the standard AWS
provider and the AWS Cloud Control provider required for the MicroVM image resource.

## What it creates

- HTTP API Gateway with public signature-validated provider routes, public machine-readable
  discovery/contracts, and IAM-authenticated owner-scoped control routes.
- Lambda ingress, control, dispatcher, reconciler, Thing-schedule, state-stream, and notification
  functions.
- Encrypted DynamoDB Agent, Session, execution and integration stores;
  encrypted S3 artifact, non-expiring definition, and MicroVM-source buckets; and encrypted SQS
  work/dead-letter queues.
- A custom EventBridge bus, an EventBridge Scheduler group with a fixed Thing target and invocation
  role, terminal-state notifier targets, failure queues, and alarms.
- A Lambda MicroVM image built from `dist/microvm-source.zip`, its execution/build roles, log group,
  and SSM image metadata.
- When enabled, one private-S3 CloudFront distribution with wildcard publication isolation, signed
  entry URLs and cookies, response hardening, and optional Route 53 aliases for file, site, and
  video sharing.

It does not create ECS or ECR. With `enable_s3_files=false`, image builds and runs use AWS-managed
networking and the stack creates no customer VPC. Enabling S3 Files creates a dedicated VPC,
private and public subnets, NAT gateway, service endpoints, and Lambda MicroVM network connector so
replacement compute can mount the same Session workspace. That optional path adds a continuous
networking cost floor and should not be confused with access to an existing application VPC.

## Package, validate, and deploy

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

`npm run package` produces the Lambda ZIPs and `dist/microvm-source.zip`. Configure a remote, locked
Terraform backend before sharing an environment. Pin a currently `AVAILABLE` managed base-image
version rather than relying on an implicit latest version.

The default driver is `mock`, so the initial infrastructure smoke test does not spend model tokens.
See [development and deployment](../docs/development-and-deployment.md) for the full validation flow.

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
default ChatGPT path reads the secret selected by `codex_auth_file_secret_arn`, validates its
file-based login, writes a mode-`0600` runtime `auth.json`, persists validated refresh rotation, and
removes the runtime copy after the turn. Never put the value in Terraform, an image, Run, state
record, or log. Codex and repository code run under the same agent UID and can read that file while
the turn is active, so this bridge is only for trusted owner-operated agents; theft of its renewable
refresh token can impersonate the Codex login even though the file has no password or MFA secret.
Optional Bedrock mode mints a short-term token from the execution role;
`codex_bedrock_model_ids` restricts inference to exact model IDs.
The Agents model catalog is operator-declared rather than inferred from Codex support metadata.
For ChatGPT authentication, set `codex_chatgpt_model_ids` to the exact IDs verified for the
deployment-owned workspace credential. An explicitly pinned `codex_chatgpt_model` supplies a
singleton catalog when that list is empty. Without either setting, model discovery returns unavailable
because the server cannot safely infer account availability from another Codex login.

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

Native MicroVM resume and conversation-history recovery remain unchanged. A replacement
hosted worker rebuilds its workspace; retained S3 Files bytes alone are not a committed
workspace recovery point. There is no automatic MicroVM-to-EC2 handoff or custom workspace
checkpoint archive in this implementation. The optional AMI pipeline below reduces work
performed at EC2 boot; it is not required for ordinary MicroVM workloads.

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

AWS-managed `INTERNET_EGRESS` gives a MicroVM outbound internet access by default. The dispatcher
therefore needs `lambda:PassNetworkConnector`; AWS currently documents no resource type or condition
key for this action, so it is isolated in its own `Resource = "*"` statement on the dispatcher role.
Re-check that limitation as the service matures.

The module permits `read-only`, `workspace-write`, and `danger-full-access` by default; its default
inner sandbox is `danger-full-access`, and agent network access defaults on. Those broad inner
defaults rely on the outer MicroVM, IAM, integration broker, and network policy as the security
boundary. The supplied `terraform.tfvars.example` explicitly narrows its mock-driver bring-up to
read-only/no-network. Review and set these values deliberately for every real deployment.

## MicroVM lifecycle

The source bundle starts a root lifecycle server on port 8080 and signals readiness only after its
runtime is initialized. It snapshots no run ID, token, repository, or workspace. Per-run identifiers
arrive in the bounded `/run` payload; the worker retrieves the full request from encrypted S3.

The agent subprocess runs as UID/GID 10001. One-shot jobs call `TerminateMicrovm` when the runner
exits. Session harnesses accept additional Turns through private authenticated control.
The Session runtime journal saves conversation state. Optional S3 Files storage retains
workspace and Codex home bytes, but hosted replacement rebuilds the workspace. Native
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
