# Live AWS end-to-end validation

This harness deploys an isolated, short-lived copy of the agent runner into the caller's AWS
account, validates it, and destroys it. It is deliberately separate from `infra/` state and gives
every resource a unique deployment ID plus `Ephemeral=true` and `DeploymentId` tags.

## One command

```bash
npm run test:e2e:aws
```

The wrapper performs these phases in order:

1. Package the Lambda functions.
2. Bootstrap the encrypted ECR repository.
3. Build and push the real `linux/arm64` worker image.
4. Apply the complete Terraform stack.
5. Populate disposable GitHub and GitLab signing secrets.
6. Test the IAM-authenticated control API, output download, signed provider webhooks, Fargate
   execution, DynamoDB Streams, EventBridge terminal events, and empty failure queues.
7. When MicroVM mode is enabled, build the managed image and VPC connector, call `RunMicrovm`, clone
   a public repository at a pinned commit, verify the mock result, and verify self-termination.
8. Stop remaining ECS tasks and MicroVMs and run `terraform destroy`, even when an earlier phase
   fails.

The stack uses the mock agent driver. It does not invoke Codex, Claude, or Bedrock and therefore does
not spend model tokens. In the default mode, ECS tasks receive public IPv4 addresses in public
subnets, so the test creates neither a NAT gateway nor paid interface VPC endpoints. Lambda MicroVM
provisioning is disabled by default.

To include a live MicroVM image build and run, pin a currently available managed `al2023-1` version:

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION=1 \
npm run test:e2e:aws
```

Version `1` was validated in `us-west-2` on 2026-08-02; discover availability again before relying on
that value. MicroVM mode temporarily creates a NAT gateway because the VPC network connector must
reach the public test repository. The cleanup trap removes it.

AWS does not allow immediate deletion of a customer-managed KMS key. Teardown disables the key and
schedules it for deletion after AWS's minimum waiting period; the post-destroy audit treats only a
`PendingDeletion` KMS key as expected. All other Terraform-managed resources are destroyed
immediately, including ECR images, S3 objects, networking, Lambdas, queues, tables, logs, test
secrets, the MicroVM image, and its network connector. The final audit verifies resource state
directly because AWS's resource-tag index can retain deleted ECS and networking records briefly.

LocalStack validates the shared data/event workflow but does not implement the Lambda MicroVM
control plane, image lifecycle, hooks, connector, or isolation. The MicroVM leg therefore remains a
live-AWS-only test.

## Manual phases

To inspect the deployed stack between phases:

```bash
./scripts/aws-e2e-deploy.sh
./scripts/aws-e2e-test.sh
./scripts/aws-e2e-destroy.sh
```

The deploy command prints the generated deployment ID and stores it in `.aws-e2e/latest`. Pass that
ID explicitly if multiple runs exist:

```bash
./scripts/aws-e2e-destroy.sh e2e-260802120000
```

Terraform state and generated runtime configuration live under `.aws-e2e/<deployment-id>/` and are
excluded from Git. The runtime file contains disposable webhook signing secrets and is securely
permissioned while the stack exists; teardown truncates and deletes it.

If the process is terminated with `SIGKILL`, the shell cannot run its cleanup trap. Use the printed
manual destroy command immediately in that case.
