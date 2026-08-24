# AWS-ready ten-minute quickstart

This is the shortest honest path from running one command in a fresh clone, with an authenticated
and prepared AWS account, to one independently operated Rat Things deployment and one **published,
invoked, active Thing**. The default runs real Codex through Amazon Bedrock inside an AWS Lambda
MicroVM. It never substitutes a mock response for the agent proof.

## What “ten minutes” means

The product gate starts when `npm run quickstart:aws` starts in the cloned repository; cloning is
not timed. On a fresh clone that command installs the pinned Node dependencies, performs readiness
checks without creating or modifying AWS resources, packages and deploys the backend, tests and
publishes the exact Thing revision, invokes that active revision, and waits for its second
successful Run. Time spent obtaining an AWS account, installing the host toolchain, receiving
Lambda MicroVM capacity, or arranging Bedrock access is **not** part of the gate and can take longer
than ten minutes.

The command writes its source commit, clean/dirty state, consistent start and finish timestamps,
elapsed seconds, Terraform resource count, active revision and `specHash`, both Run IDs, and both
output previews to `.runtime/aws-quickstart/result.json`. It fails above ten minutes. Complete npm,
package, and Terraform diagnostics go to `.runtime/aws-quickstart/quickstart.log`.

## Get the workstation and AWS account ready

Install [Node.js 20+](https://nodejs.org/en/download), npm, [Git](https://git-scm.com/downloads),
[Terraform 1.5+](https://developer.hashicorp.com/terraform/install), and the
[AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). The default
`openai.gpt-5.6-terra` path supports `us-east-1`, `us-east-2`, or `us-west-2`: the intersection of
the model's [documented Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html)
and Lambda MicroVM availability. A deliberate custom run can use another supported MicroVM Region
only by naming a model available there; preflight checks that choice. This first path does not guess
the pairing.

Authenticate the AWS CLI before cloning. AWS IAM Identity Center is the recommended local path;
reuse an existing profile or environment-based credentials if your account already supplies one.

```bash
aws configure sso --profile rat-things-sandbox
aws sso login --profile rat-things-sandbox
aws sts get-caller-identity --profile rat-things-sandbox
```

Keep that profile name. The setup, optional preflight, status, and destroy commands below must use
the same identity and Region.

For the first proof, use a disposable AWS sandbox account or an isolated sandbox role. The fastest
known path is temporary administrator deployment access, revoked after teardown. Those credentials
stay in the host process: the generated agent role is separate and
`allow_agent_aws_credential_chain=false`. If your organization requires a custom deployer policy,
it must cover API Gateway, CloudWatch Logs/alarms, DynamoDB, EventBridge/Scheduler, IAM role and
policy management including `iam:PassRole`, KMS, Lambda and Lambda MicroVMs, S3, SQS, SSM, STS,
tagging, and the AWS Cloud Control API used by the Terraform AWSCC provider. The checked-in
Terraform plan is the exact resource source of truth; do not treat a stale copied policy as safer.

The account also needs:

- Lambda MicroVM service access and at least 4 GiB of unused regional memory quota for the default
  Run. In the [Service Quotas console](https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas),
  choose AWS Lambda and search for “MicroVM.” AWS documents the
  [quota and capacity model](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
  including how to request an increase, and the
  [operator IAM actions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html).
- `bedrock-mantle:CallWithBearerToken` plus model-list access for preflight, and inference access for
  the generated runtime role. The preflight command is the concrete access check: it must report
  `modelVisible: true`. AWS publishes the
  [Mantle inference policy](https://docs.aws.amazon.com/bedrock/latest/userguide/inference.html) and
  the [`openai.gpt-5.6-terra` model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html).

The validated quickstart creates 158 mostly request-scale managed resources and invokes the paid
model twice. The validation record does not include an AWS bill, so it makes no dollar claim. Use a
sandbox account and review the dated [cost measurements and residual KMS deletion window](costs.md)
before confirming; your Region, tokens, account pricing, and later AWS price changes determine the
actual charge.

## Run the complete path

```bash
git clone --depth 1 https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm run quickstart:aws -- --profile rat-things-sandbox --region us-west-2
```

Omit `--profile` only when your shell already supplies the intended AWS credentials. Omit `--region`
only when `AWS_REGION` or `AWS_DEFAULT_REGION` already selects one of the three supported default
Regions.

The quickstart command output is a six-stage readiness and deployment journey. It pauses once before any
AWS write to show the exact account, Region, MicroVM image, driver, model-cost boundary, local state
path, and deliberately omitted features. Confirm only when that target is correct.

The command then:

1. verifies host tool versions, AWS identity, managed MicroVM image access, and visibility of the
   selected Bedrock model without invoking it;
2. packages Rat Things and applies the narrow backend, with no VPC/NAT, OAuth account, schedule, or
   public-sharing distribution;
3. runs `rat-things doctor` against public discovery and the IAM-authenticated API;
4. creates a read-only, no-network manual Thing;
5. explains it, tests its exact immutable draft in a real MicroVM, verifies the marker, and publishes
   only that revision and `specHash`; and
6. invokes the published active revision, waits for success, and verifies the same immutable binding
   and a new Run receipt.

Success is deliberately redundant and machine-readable:

```json
{
  "version": 2,
  "status": "ready",
  "source": { "commit": "...", "clean": true },
  "terraformManagedResourceCount": 158,
  "thing": {
    "thingId": "...",
    "status": "active",
    "activeRevision": 1,
    "specHash": "..."
  },
  "runs": {
    "draftTest": { "runId": "...", "status": "succeeded", "invocation": "test" },
    "active": { "runId": "...", "status": "succeeded", "invocation": "manual" }
  },
  "measurementScope": "quickstart command through successful active-revision Run",
  "elapsedSeconds": 0,
  "underTenMinutes": true
}
```

## Review first without AWS writes

Run these after cloning. The wrapper installs pinned local dependencies when they are absent.

```bash
npm run quickstart:aws -- preflight --profile rat-things-sandbox --region us-west-2
npm run quickstart:aws -- --dry-run --profile rat-things-sandbox --region us-west-2
```

`preflight` creates, updates, and deletes no AWS resources. It checks the active AWS identity,
resolves a managed MicroVM base image, mints a short-lived Bedrock authentication token, and
confirms that the selected model appears in the model catalog. Token minting is an authentication
action, not a read/list call. Preflight cannot prove remaining capacity, organization SCP behavior,
Marketplace readiness, or successful inference; the two live Runs prove the end-to-end path. If the
first invocation reports `AccessDeniedException`, follow Amazon Bedrock's
[model-access prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html),
wait for any first-use subscription to settle, and rerun.

## Published validation evidence

The published validation record pins the exact tested commit and contains no credential values. It is
updated only after a fresh-clone real-Codex run, active-revision invocation, teardown, empty-state
check, and no-MicroVM check all pass: [latest AWS quickstart evidence](aws-quickstart-evidence.json).

On August 23, 2026, a clean clone of commit
[`7ff0bbf`](https://github.com/gpazo/Rat-Things/commit/7ff0bbfa183f2b85e063ff5e5c27d839e07cc85a)
installed its pinned dependencies, passed
preflight, created 158 managed resources in `us-west-2`, tested and published revision 1, then ran
that active revision through a second real `openai.gpt-5.6-terra` invocation in **508 seconds
(8m28s)**. The post-run status check found a healthy API, an active Thing with no unpublished
changes, and the active Run as `lastRunId`. The self-verifying destroy then found zero Terraform
state entries, zero active MicroVMs, and only the disabled KMS key in `PendingDeletion`.

This recorded validation covers the narrow path, not load, quota, multi-tenant, or disaster recovery.

Use a named AWS profile or Region without editing Terraform:

```bash
npm run quickstart:aws -- --profile personal --region us-west-2
```

For a token-free infrastructure diagnostic, choose the mock explicitly:

```bash
npm run quickstart:aws -- --driver mock
```

That mode proves deployment, IAM-authenticated discovery, the complete Thing lifecycle, durable
state, queueing, MicroVM launch, artifacts, exact tested-revision publication, and active-revision
invocation. It is not a model or agent-behavior proof, and the command labels it that way before
making changes.

## Inspect and remove it

The quickstart is deliberately disposable. Its state and non-secret evidence stay under
`.runtime/aws-quickstart/`; it does not touch a normal `infra/terraform.tfstate` or require a remote
state backend. The full debug log is local, ignored by Git, and intended to make a failed stage
inspectable without filling the normal terminal path with thousands of Terraform lines.

```bash
npm run quickstart:aws -- status --profile rat-things-sandbox --region us-west-2
npm run quickstart:aws -- destroy --profile rat-things-sandbox --region us-west-2
```

`status` reruns deployment diagnostics and reads the exact Thing. `destroy` confirms the target,
terminates any remaining MicroVM for this image, destroys only the quickstart state, then fails
unless Terraform state is empty, no MicroVM remains active, and the disabled customer-managed KMS
key is in AWS's mandatory `PendingDeletion` window. Those postchecks are appended to the local
result record.

Do not use this disposable state layout as an unreviewed shared production deployment. Once the
narrow journey is delightful and stable, choose retention, state backend, identity boundary,
durable conversations, integrations, schedules, and publication delivery deliberately in the
[deployment guide](development-and-deployment.md).

## If it stops

- `required command not found` or `... is required`: install the named prerequisite and rerun.
- `could not discover a Lambda MicroVM base image`: confirm Region/service access, or pass a known
  available version with `--microvm-base-image-version`.
- Terraform `AccessDenied`: the active principal cannot create one of the printed resources. Do not
  broaden agent permissions; fix the host deployment role.
- A failed Codex test with a Bedrock error: confirm model access in the selected Region, or rerun
  with another `--model`. Use `--driver mock` only when the goal is infrastructure diagnosis.
- A failed Thing explanation or test prints the created Thing ID before stopping. Inspect it with
  `npm run rat-things -- thing THING_ID`, then use [diagnostics](diagnostics.md).
- An interrupted setup may leave exact resources in the quickstart state. Run
  `npm run quickstart:aws -- destroy`; do not delete the state file first.

The quickstart intentionally proves one small product path. Continue with [Things](things.md), then
add [accounts and permissions](plugins.md) or the [deeper agent controls](agents.md) only when the
task needs them.
