# AWS infrastructure

This Terraform root deploys the Rat Things control plane and Lambda MicroVM image. One-shot VMs are
terminated; conversation VMs may be suspended and resumed for a bounded session. Individual
MicroVM instances are managed through the service API; they are not Terraform resources.

The reusable implementation is in `modules/agent-runner`. This root configures the standard AWS
provider and the AWS Cloud Control provider required for the MicroVM image resource.

## What it creates

- HTTP API Gateway with public signature-validated provider routes, public machine-readable
  discovery/contracts, and IAM-authenticated owner-scoped control routes.
- Lambda ingress, control, dispatcher, reconciler, state-stream, and notification functions.
- Encrypted DynamoDB run, conversation, integration, routine, and revisioned Thing stores;
  encrypted S3 artifact, non-expiring definition, and MicroVM-source buckets; and encrypted SQS
  work/dead-letter queues.
- A custom EventBridge bus, terminal-state notifier target, failure queues, and alarms.
- A Lambda MicroVM image built from `dist/microvm-source.zip`, its execution/build roles, log group,
  and SSM image metadata.
- When enabled, one private-S3 CloudFront distribution with wildcard publication isolation, signed
  entry URLs and cookies, response hardening, and optional Route 53 aliases for file, site, and
  video sharing.

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

Publication delivery is optional and requires a separate registrable wildcard user-content domain,
a matching CloudFront certificate in `us-east-1`, an RSA public key, and the matching private key in
Secrets Manager. See [publications](../docs/publications.md#aws-setup) for the complete setup and
security model. The module output `publication_delivery` reports the distribution and DNS state.

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

The agent subprocess runs as UID/GID 10001. One-shot jobs call `TerminateMicrovm` when the runner
exits. Conversation jobs retain the workspace and Codex thread, then the completion coordinator
calls `SuspendMicrovm`; a later slice resumes the VM through its authenticated HTTPS endpoint.

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
