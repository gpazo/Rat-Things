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
4. Reads public discovery, OpenAPI, and Thing schemas, then sends IAM-authenticated Thing, one-shot,
   and headless conversation requests plus real signed provider webhook requests.
5. Registers two separately credentialed accounts for one integration and verifies connection sets,
   provider/grant/Thing/profile permission intersection, immutable KMS-encrypted definitions,
   idempotent Thing execution, lifecycle changes, rotation, revocation, and no secret leakage.
6. Enables an interval Thing and waits for EventBridge to submit the occurrence without an explicit
   run request, then verifies exactly one durable run with trusted schedule and Thing provenance.
7. Verifies MicroVM execution, pinned public-repository checkout, S3 output/events, DynamoDB state,
   EventBridge terminal events, Teams Adaptive Card egress, empty failure queues, and self-termination.
8. Sends two signed Teams activities and runs two messages through the actual Rat Things CLI,
   proves actual AWS suspension, authenticated continuation and resume on the same MicroVM ID,
   replay, provider egress where applicable, and re-suspension.
9. Backdates a suspended session to prove replacement, replay, and expired-VM termination, then
   injects the coordinator launch/attach crash window and proves idempotent repair.
10. Terminates any remaining MicroVMs, force-deletes runtime-created connection secrets, runs
   `terraform destroy` from an exit trap, and audits tagged residual resources.

The default stack uses the mock driver. It does not invoke Codex or Bedrock, so it spends no model
tokens. It creates no ECS/ECR resources. The S3 Files persistence leg does create a disposable VPC,
NAT gateway, VPC endpoints, and customer network connector; MicroVMs also retain AWS-managed public
egress. Every one of those resources is tagged and included in teardown auditing.

Set `AWS_E2E_REAL_CODEX=true` to add two bounded `openai.gpt-5.6-terra` probes through Bedrock. The
worker execution role mints a short-term token and the unprivileged Codex process receives only that
token. The persistence probe writes unique bytes through a command tool call, resumes the same
MicroVM and Codex thread, and reads those bytes from the same workspace path. A provider probe has
Codex call Slack's real `api.test` endpoint successfully and then verifies Slack's real
`invalid_auth` denial through a credentialed read-only operation using a disposable invalid token.
The tests verify tool events, provider error propagation, workspace patches, usage, state,
re-suspension, no credential leakage, and empty failure queues. The provider probe does not require
or claim access to workspace data; supply a dedicated OAuth fixture before testing authenticated
reads or writes.

Set both publication variables to add the isolated CloudFront delivery path to the disposable stack:

```bash
AWS_E2E_PUBLICATION_DOMAIN="agent-content.example.com" \
AWS_E2E_PUBLICATION_ROUTE53_ZONE_ID="Z1234567890" \
./scripts/aws-e2e-deploy.sh demo
```

The deploy helper creates and DNS-validates a wildcard certificate in `us-east-1`, generates an
ephemeral CloudFront signing-key pair, stores only the private key in Secrets Manager, and removes
the local key files even if deployment fails. The base domain must be dedicated to untrusted agent
content and owned by the supplied public Route 53 zone. Terraform teardown removes the certificate,
validation record, wildcard aliases, distribution, key group, and signing-key secret.

Version `1` of the managed `al2023-1` base image was validated in `us-west-2` on 2026-08-03–04.
Managed Rat Things image versions `1.0` through `3.0` were created during integration debugging; the
final persistence run used `3.0`. Discover
availability again before relying on that value.

A fresh version `1` deployment passed all seven live workflows again on 2026-08-14. A focused
canary also launched the built `rat-things` executable twice against that stack and proved named
thread continuation on the same suspended MicroVM.

On 2026-08-21 deployment `th260821c` passed all seven applicable workflows (two opt-in cases were
skipped), including the revisioned multi-account Thing path. The harness terminated six MicroVMs,
removed runtime-created secrets, destroyed all 208 Terraform resources, and passed its tagged
post-destroy audit.

Later that day deployment `ev260821a` closed the remaining scheduled-Thing and real-provider
transport gaps. Ten applicable workflows passed with the real-Codex option enabled and only the
unconfigured custom-domain publication case skipped. EventBridge produced exactly one durable
scheduled Thing run without an API invocation; a real Codex agent then completed Slack `api.test`
and observed Slack's expected `invalid_auth` denial on the credentialed operation. Teardown
terminated seven MicroVMs, destroyed all 208 Terraform resources, passed the tagged-resource audit,
and left Terraform state empty.

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
