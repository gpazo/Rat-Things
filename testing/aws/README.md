# Live AWS end-to-end validation

This harness deploys an isolated, short-lived Rat Things stack into the caller's AWS account,
validates it, and destroys it. It uses separate Terraform state and tags every resource with a
unique deployment ID.

## One command

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<available pinned version>" \
npm run test:e2e:aws
```

The wrapper:

1. Packages the Lambda functions and MicroVM source bundle.
2. Applies the complete ephemeral Terraform stack and waits for the managed image.
3. Populates disposable GitHub, GitLab, Teams, and egress-capture secrets.
4. Sends an IAM-authenticated control request and real signed provider webhook requests.
5. Verifies MicroVM execution, pinned public-repository checkout, S3 output/events, DynamoDB state,
   EventBridge terminal events, Teams Adaptive Card egress, empty failure queues, and self-termination.
6. Terminates any remaining MicroVMs and runs `terraform destroy` from an exit trap.

The default stack uses the mock driver. It does not invoke Codex or Bedrock, so it spends no model
tokens. It creates no ECS/ECR resources, customer VPC, NAT gateway, or customer network connector;
MicroVMs use AWS-managed public egress.

Set `AWS_E2E_REAL_CODEX=true` to add one real `openai.gpt-5.6-terra` request through Bedrock. The
worker execution role mints a short-term token, the unprivileged Codex process receives only that
token, and the test verifies non-mock output, usage accounting, artifacts, state, and termination.

Version `1` of the managed `al2023-1` image was validated in `us-west-2` on 2026-08-03. Discover
availability again before relying on that value.

AWS does not allow immediate deletion of a customer-managed KMS key. Teardown disables the key and
schedules it for deletion after AWS's minimum waiting period; only that `PendingDeletion` key is an
expected residual resource. All other Terraform-managed resources are destroyed and directly
audited.

LocalStack validates the shared data/event workflow but does not implement the Lambda MicroVM
control plane, image lifecycle, hooks, managed connectors, or isolation. This leg is therefore a
live-AWS-only test.

## Manual phases

```bash
./scripts/aws-e2e-deploy.sh
./scripts/aws-e2e-test.sh
./scripts/aws-e2e-destroy.sh
```

The deploy command stores the generated deployment ID in `.aws-e2e/latest`. Pass it explicitly when
multiple runs exist:

```bash
./scripts/aws-e2e-destroy.sh e2e-260802120000
```

Terraform state and generated runtime configuration live under `.aws-e2e/<deployment-id>/` and are
ignored by Git. The runtime file contains disposable signing secrets and is permissioned while the
stack exists; teardown removes it. If a process is killed with `SIGKILL`, run the printed manual
destroy command immediately.
