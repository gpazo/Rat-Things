# AWS infrastructure

This Terraform root deploys the Rat Things control plane and the Lambda MicroVM image used for one
isolated execution per run. Individual MicroVM instances are created and terminated through the
service API; they are not Terraform resources.

The reusable implementation is in `modules/agent-runner`. This root configures the standard AWS
provider and the AWS Cloud Control provider required for the MicroVM image resource.

## What it creates

- HTTP API Gateway with public signature-validated provider routes and IAM-authenticated `/v1/runs`
  routes.
- Lambda ingress, control, dispatcher, reconciler, state-stream, and notification functions.
- An encrypted, streamed DynamoDB run table, encrypted S3 artifact and MicroVM-source buckets, and
  an encrypted SQS run queue/dead-letter queue.
- A custom EventBridge bus, terminal-state notifier target, failure queues, and alarms.
- A Lambda MicroVM image built from `dist/microvm-source.zip`, its execution/build roles, log group,
  and SSM image metadata.

It does not create ECS, ECR, a customer VPC, subnets, a NAT gateway, or a customer MicroVM network
connector. Image builds and runs use AWS-managed networking. Add a customer VPC connector only in a
separate reviewed deployment that must reach private VPC resources.

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

## Credentials and network behavior

Terraform accepts Secrets Manager **ARNs**, never secret values. Separate clone and notification
ARNs keep repository-read authority independent from comment-posting authority. The older combined
GitHub/GitLab token inputs are migration aliases only.

The trusted root process resolves configured secrets. Agent subprocesses do not inherit the
MicroVM AWS credential chain unless `allow_agent_aws_credential_chain=true` is explicitly set. The
preferred Codex/Bedrock path mints a short-term token from the execution role and passes only that
token to the UID 10001 child. `codex_bedrock_model_ids` restricts inference to exact model IDs.
Personal ChatGPT/Codex account authentication is intentionally local-only; do not place a reusable
device `auth.json` in the MicroVM image or in Secrets Manager for repository-controlled execution.

AWS-managed `INTERNET_EGRESS` gives a MicroVM outbound internet access by default. The dispatcher
therefore needs `lambda:PassNetworkConnector`; AWS currently documents no resource type or condition
key for this action, so it is isolated in its own `Resource = "*"` statement on the dispatcher role.
Re-check that limitation as the service matures.

`allowed_sandbox_modes` defaults to `read-only,workspace-write`. Add `danger-full-access` only after
reviewing the MicroVM, workload-role, repository, and egress boundaries.

## MicroVM lifecycle

The source bundle starts a root lifecycle server on port 8080 and signals readiness only after its
runtime is initialized. It snapshots no run ID, token, repository, or workspace. Per-run identifiers
arrive in the bounded `/run` payload; the worker retrieves the full request from encrypted S3.

The agent subprocess runs as UID/GID 10001. A termination helper calls `TerminateMicrovm` when the
root runner exits so batch jobs do not remain until the service duration limit.

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

Service references:

- <https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html>
- <https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html>
