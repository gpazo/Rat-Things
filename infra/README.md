# AWS infrastructure

This Terraform root deploys the durable agent-runner control plane and the reusable isolation
primitives. It does **not** model individual runs: the dispatcher creates one short-lived Fargate
task or Lambda MicroVM per run and terminates it through the service API.

The reusable implementation is in `modules/agent-runner`; this directory is a small development
root that configures both the HashiCorp AWS provider and AWS Cloud Control provider.

## What it creates

- HTTP API Gateway with public signature-validated GitHub, GitLab, Teams, and optional Slack routes,
  plus IAM-authenticated `/v1/runs` control routes.
- Lambda ingress, control, dispatcher, reconciler, state-stream, and notification functions.
- An encrypted, streamed DynamoDB runs table. The state stream publishes changes to a custom
  EventBridge bus; terminal events invoke the notifier. A one-minute reconciler re-enqueues stale
  `queued` records and finalizes cancellations that never launched.
- An encrypted SQS run queue and dead-letter queue.
- A separate 14-day SQS on-failure destination for stream records that still fail after ten retries
  and batch bisection. Records remain eligible for retries for up to the DynamoDB Streams 24-hour
  retention window.
- A separate 14-day SQS dead-letter queue for terminal events that exhaust the EventBridge
  notifier target's explicit 24-hour/185-attempt retry policy, plus alarms for queued events and
  failures to write to the DLQ.
- An SSE-S3 artifact bucket matching the runtime's explicit `AES256` writes, plus a KMS-encrypted
  MicroVM source bucket. DynamoDB, SQS, ECR, and MicroVM source objects use the customer-managed key.
- An immutable ECR repository, ECS cluster, and ARM64 Fargate task definition. There is no always-on
  ECS service; isolation is one task per run.
- A two-AZ VPC with no runner ingress, S3/DynamoDB gateway endpoints, optional paid interface
  endpoints, and an optional single NAT gateway.
- Optional AWS Lambda MicroVM image and VPC egress connector resources.

## Package and validate

From the repository root:

```bash
npm ci
npm run package
terraform -chdir=infra init -backend=false
terraform -chdir=infra fmt -recursive -check
terraform -chdir=infra validate
cp infra/terraform.tfvars.example infra/terraform.tfvars
terraform -chdir=infra plan
```

`npm run package` must produce these archives before plan/apply:

```text
dist/control.zip
dist/dispatcher.zip
dist/notifier.zip
dist/reconciler.zip
dist/state-stream.zip
dist/webhook-{github,gitlab,teams,slack}.zip  # only enabled routes are required
dist/microvm-source.zip                       # only when enable_microvm=true
```

Configure a remote, locked Terraform backend before sharing an environment. No backend is embedded
in the module so consumers can choose their own state system.

## Deploy the ECS worker

Apply once to create ECR, then push the exact immutable tag configured by `worker_image_tag`:

```bash
repository="$(terraform -chdir=infra output -raw worker_repository_url)"
registry="${repository%%/*}"
aws ecr get-login-password --region us-west-2 \
  | docker login --username AWS --password-stdin "$registry"
docker build --platform linux/arm64 -t "$repository:dev" .
docker push "$repository:dev"
```

Use a new content-addressed or release tag for every update; ECR tag mutation is disabled. Update
`worker_image_tag` and apply again to publish a new task-definition revision. The default driver is
`mock`, so initial smoke tests do not spend model tokens.

The runner security group has no ingress. Internet egress for Git hosts and hosted model APIs needs
`enable_nat_gateway=true`; this creates a billable NAT gateway. Interface endpoints are independently
opt-in because they also have hourly charges.

## Provider and channel secrets

Terraform accepts Secrets Manager **ARNs**, never secret values. Separate clone and notify ARNs keep
worker credentials independent from tokens that can post comments:

```hcl
github_clone_token_secret_arn  = "arn:aws:secretsmanager:...:secret:github-clone-..."
github_notify_token_secret_arn = "arn:aws:secretsmanager:...:secret:github-notify-..."
gitlab_clone_token_secret_arn  = "arn:aws:secretsmanager:...:secret:gitlab-clone-..."
gitlab_notify_token_secret_arn = "arn:aws:secretsmanager:...:secret:gitlab-notify-..."
```

The older `github_token_secret_arn` and `gitlab_token_secret_arn` inputs remain fallback aliases for
migration only. Teams is the primary chat path. One default Workflow URL and optional named routes
can be configured:

For self-hosted forges, set `github_api_base_url` to the GitHub Enterprise Server REST endpoint
(normally `https://github.example.com/api/v3`) or `gitlab_api_base_url` to the instance v4 endpoint
(normally `https://gitlab.example.com/api/v4`). Add each forge hostname to
`allowed_repository_hosts`; the notifier receives these URLs explicitly rather than assuming the
public SaaS APIs.

```hcl
teams_workflow_url_secret_arn = "arn:aws:secretsmanager:...:secret:teams-default-..."
teams_route_secret_arns = {
  security = "arn:aws:secretsmanager:...:secret:teams-security-..."
  platform = "arn:aws:secretsmanager:...:secret:teams-platform-..."
}
```

The optional `bedrock_api_key_secret_arn` is passed only as an ARN to the root orchestration process.
The runner resolves it and passes the bearer value to the unprivileged Codex child. Agent subprocesses
do not inherit the task/MicroVM AWS credential chain unless
`allow_agent_aws_credential_chain=true` is explicitly set. Claude-on-Bedrock requires that explicit
credential-chain opt-in; the scoped bearer-token path is intended for Codex/Mantle.

`allowed_sandbox_modes` defaults to `read-only,workspace-write`. Add `danger-full-access` only after
reviewing the task/MicroVM outer isolation boundary.

## Lambda MicroVM preview

MicroVM resources are isolated behind `enable_microvm=false`. The normal AWS provider does not yet
expose these resources; the module pins AWSCC 1.95.0 and uses its first-class
`awscc_lambda_microvm_image` and `awscc_lambda_network_connector` resources.

Before opting in:

1. Use a supported Region: `us-east-1`, `us-east-2`, `us-west-2`, `ap-northeast-1`, or `eu-west-1`.
2. Run `npm run package`.
3. Discover and pin an `AVAILABLE` managed `al2023-1` base-image version:

   ```bash
   aws lambda-microvms list-managed-microvm-image-versions \
     --image-identifier arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1
   ```

4. Set `enable_nat_gateway=true`, `enable_microvm=true`, and
   `microvm_base_image_version=<pinned version>`.
5. Apply and wait for the image state/output to become active. Image builds can take several minutes.

Image builds use the AWS-managed `INTERNET_EGRESS` connector. Runs use the customer-managed VPC
connector and its no-ingress security group. The image and connector ARNs plus the active image
version are written to SSM; the dispatcher reads and pins all three for every `RunMicrovm` call.

The current AWSCC schema requires a non-empty `additional_os_capabilities` value and AWS currently
accepts only `ALL`, so the Terraform image explicitly requests `ALL`. Those capabilities stay inside
the MicroVM boundary, and the runtime launches the agent subprocess as UID/GID 10001, but this is
still a production security-review item rather than a least-privilege claim.

The disposable harness under `testing/aws` successfully built image version 1 and completed a real
mock-agent MicroVM run in `us-west-2` on 2026-08-02. That proof is repeatable with
`AWS_E2E_ENABLE_MICROVM=true`; it does not make the backend production-ready.

The MicroVM source starts a root lifecycle server on port 8080 and snapshots it only after `/ready`.
Per-run identity and configuration arrive through `/run`; no secrets or unique IDs are created during
the snapshot build. When the root runner exits, a separate helper calls `TerminateMicrovm` so batch
runs do not linger until their maximum duration.

## Recover a state-stream failure

The `state_stream_failure_queue_url` output identifies the SQS on-failure destination, and the
`<name>-state-stream-failures` CloudWatch alarm enters ALARM whenever it has visible messages. Treat
any message as an operator incident:

1. Read but do not delete the SQS message. `DDBStreamBatchInfo` identifies the stream ARN, shard, and
   failed sequence-number range.
2. Within DynamoDB Streams' 24-hour retention window, retrieve that range and replay it through the
   state-stream handler. The publisher and notifier delivery fence make duplicate delivery safe.
3. If the stream record has expired, read the current run item from DynamoDB and reconstruct the
   `Agent Run State` EventBridge detail (`version`, `runId`, `ownerId`, `status`, `sourceKind`, and
   `occurredAt`, plus terminal preview/error fields). Publish it to the `event_bus_name` output with
   source `indubitably.agent-runtime` and detail type `Agent Run State`.
4. Verify the downstream notification/delivery-fence record, then delete the failure message.

SQS retains only Lambda's failed-invocation and DynamoDB sequence metadata, not the full original
record. The runs table is therefore the durable recovery source after the stream's 24-hour window.

## Recover a notifier-target failure

The `notifier_delivery_failure_queue_url` output identifies terminal events that EventBridge could
not deliver to the notifier Lambda after up to 24 hours and 185 attempts. The
`<name>-notifier-delivery-failures` alarm detects queued events, while
`<name>-notifier-dlq-delivery-failures` detects EventBridge being unable to write the DLQ itself.
Fix the Lambda target or its invoke permissions, redrive each retained event to the notifier, verify
the per-destination delivery fence in the runs table, and only then delete the DLQ message.

AWS Lambda MicroVMs documentation:

- <https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html>
