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
4. Sends IAM-authenticated one-shot and headless conversation requests plus real signed provider
   webhook requests.
5. Verifies MicroVM execution, pinned public-repository checkout, S3 output/events, DynamoDB state,
   EventBridge terminal events, Teams Adaptive Card egress, empty failure queues, and self-termination.
6. Sends two signed Teams activities and runs two messages through the actual Rat Things CLI,
   proves actual AWS suspension, authenticated continuation and resume on the same MicroVM ID,
   replay, provider egress where applicable, and re-suspension.
7. Backdates a suspended session to prove replacement, replay, and expired-VM termination, then
   injects the coordinator launch/attach crash window and proves idempotent repair.
8. Terminates any remaining MicroVMs and runs `terraform destroy` from an exit trap.

The default stack uses the mock driver. It does not invoke Codex or Bedrock, so it spends no model
tokens. It creates no ECS/ECR resources, customer VPC, NAT gateway, or customer network connector;
MicroVMs use AWS-managed public egress.

Set `AWS_E2E_REAL_CODEX=true` to add a bounded two-turn `openai.gpt-5.6-terra` probe through
Bedrock. The worker execution role mints a short-term token and the unprivileged Codex process
receives only that token. Turn one writes unique bytes through a command tool call; turn two resumes
the same MicroVM and Codex thread and reads those bytes from the same workspace path. The test also
verifies tool events, workspace patches, usage, state, re-suspension, and empty failure queues.

Version `1` of the managed `al2023-1` base image was validated in `us-west-2` on 2026-08-03–04.
Managed Rat Things image versions `1.0` through `3.0` were created during integration debugging; the
final persistence run used `3.0`. Discover
availability again before relying on that value.

A fresh version `1` deployment passed all seven live workflows again on 2026-08-14. A focused
canary also launched the built `rat-things` executable twice against that stack and proved named
thread continuation on the same suspended MicroVM.

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
