# AWS quickstart

This is the shortest path from local Codex to an independently operated Rat Things deployment and
one **published, invoked, active Thing**. Local work uses the ChatGPT subscription already signed in
on the operator's device. By default, the cloud handoff validates that same file-based ChatGPT
login, copies it into AWS Secrets Manager after explicit consent, and runs Codex's built-in OpenAI
provider inside an isolated Lambda MicroVM. Amazon Bedrock is optional rather than the product
default.

> [!TIP]
> **Bring your Codex subscription.** The default path uses the Codex access included with the
> ChatGPT plan already signed in on this device. It does not require an OpenAI Platform API key or
> Amazon Bedrock; the quickstart explains and confirms the file-credential bridge before uploading.

## What setup does

The command installs pinned dependencies, checks prerequisites, packages and deploys the backend,
then tests, publishes, and invokes the same Thing revision. Account setup, tool installation,
service capacity, and provider access must be ready beforehand.

The local `.runtime/aws-quickstart/result.json` stores the selected deployment context, source
revision, Thing revision, Run receipts, and elapsed time. Setup succeeds when the deployment and
both Runs complete successfully; elapsed time is diagnostic information. Detailed diagnostics are
retained in `.runtime/aws-quickstart/quickstart.log` for interrupted setup and recovery.

## Get the workstation and AWS account ready

The entry point requires Bash and is intended for macOS or Linux, including WSL 2. Native Windows
PowerShell and Command Prompt are not supported by this path.

Install [Bash](https://www.gnu.org/software/bash/),
[Node.js 22.20+](https://nodejs.org/en/download), npm, [Git](https://git-scm.com/downloads),
[Terraform 1.5+](https://developer.hashicorp.com/terraform/install), and the
[AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). The
ChatGPT workspace path can use any Region where Lambda MicroVMs are available. The optional default
Bedrock model supports `us-east-1`, `us-east-2`, or `us-west-2`; a deliberate Bedrock deployment can
choose another supported MicroVM Region only with a model available there.

Authenticate the AWS CLI before cloning. AWS IAM Identity Center is the recommended local path;
reuse an existing profile or environment-based credentials if your account already supplies one.

```bash
aws configure sso --profile rat-things-sandbox
aws sso login --profile rat-things-sandbox
aws sts get-caller-identity --profile rat-things-sandbox
```

Keep that profile name. Pass it and the Region to setup once. Setup stores only their non-secret
names under `.runtime/aws-quickstart/`; later `status` and `destroy` commands automatically reuse
them. Pass the same flags to a standalone preflight because no setup context exists yet.

Use a disposable AWS sandbox account or an isolated deployment role. Host credentials provision
infrastructure; the generated agent role is separate and `allow_agent_aws_credential_chain=false`.

Rat Things does not ship an exact least-privilege deployer policy. Derive one from the Terraform
plan for the features you enable, including role creation and `iam:PassRole`. The
[deployment guide](development-and-deployment.md) describes the provisioned services.

The account also needs:

- Lambda MicroVM service access and at least 4 GiB of unused regional memory quota for the default
  Run. In the [Service Quotas console](https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas),
  choose AWS Lambda and search for “MicroVM.” AWS documents the
  [quota and capacity model](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
  including how to request an increase, and the
  [operator IAM actions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html).
- A file-based ChatGPT Codex login on the setup device. OpenAI documents file-backed storage with
  `cli_auth_credentials_store = "file"` and `auth.json` in the
  [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
  The quickstart validates the file locally, explains the account risk, and asks for explicit
  consent before creating an encrypted Secrets Manager copy. Copying it to AWS is a Rat Things
  bridge and should be used only with agents and AWS accounts you trust.
- For optional Bedrock mode, `bedrock-mantle:CallWithBearerToken`, model-list access for preflight,
  and inference access for the generated runtime role.

The quickstart creates AWS resources and invokes the selected model twice. Review the
[cost model and KMS deletion window](costs.md) before confirming; region, runtime, tokens, and
account pricing determine the actual charge.

## Run the complete path

```bash
git clone --depth 1 https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm run quickstart:aws -- --profile rat-things-sandbox --region us-west-2
```

The quickstart prints a dedicated credential warning and requires a separate confirmation
before it uploads the local login. With `--yes`, also pass
`--accept-codex-credential-risk` or setup fails closed.

> [!WARNING]
> `auth.json` contains bearer and renewable refresh credentials. It does not contain your password
> or MFA secret, but theft may still impersonate the Codex login, consume subscription usage, and
> reach Codex-visible data or connectors. Use only an AWS account and agents you trust. Read
> [the complete credential lifecycle](codex-subscription.md#credential-risk-and-lifecycle) before
> accepting.

Omit `--profile` only when your shell already supplies the intended AWS credentials. Omit `--region`
only when `AWS_REGION` or `AWS_DEFAULT_REGION` already selects a supported Lambda MicroVM Region.

The quickstart command output is a six-stage readiness and deployment journey. Before any AWS
write, it shows the exact account, Region, MicroVM image, driver, model-cost boundary, local state
path, and deliberately omitted features. ChatGPT mode adds a separate credential-risk confirmation.
Confirm both only when the target and credential transfer are acceptable.

The command then:

1. verifies host tool versions, AWS identity, managed MicroVM image access, and the structure of the
   local file-based ChatGPT login without printing its value;
2. after consent, creates a quickstart-managed Secrets Manager copy, packages Rat Things, and
   applies the narrow backend with no VPC/NAT, OAuth account, schedule, or public sharing;
3. runs `rat-things doctor` against public discovery and the IAM-authenticated API;
4. creates a read-only, no-network manual Thing;
5. explains it, tests its exact immutable draft in a real MicroVM, verifies the marker, and publishes
   only that revision and `specHash`; and
6. invokes the published active revision, waits for success, and verifies the same immutable binding
   and a new Run receipt.

The result includes the active Thing revision and separate Run receipts:

```json
{
  "status": "ready",
  "thing": {
    "thingId": "...",
    "status": "active",
    "activeRevision": 1,
    "specHash": "..."
  },
  "runs": {
    "draftTest": { "runId": "...", "status": "succeeded", "invocation": "test" },
    "active": { "runId": "...", "status": "succeeded", "invocation": "manual" }
  }
}
```

`ready` means the active Run succeeded. The destroy command rewrites the local record to
`destroyed` after removing the deployment.

## Review first without AWS writes

Run these after cloning. The wrapper installs pinned local dependencies when they are absent.

```bash
npm run quickstart:aws -- preflight --profile rat-things-sandbox --region us-west-2
npm run quickstart:aws -- --dry-run --profile rat-things-sandbox --region us-west-2
```

`preflight` creates, updates, and deletes no AWS resources. It checks the active AWS identity,
resolves a managed MicroVM base image, and validates the local `auth.json` structure without
printing or uploading its value. Preflight cannot prove remaining capacity, account entitlements,
token validity, or successful inference; those depend on the deployed Run. With
`--auth bedrock`, preflight instead mints a short-lived Bedrock authentication token and confirms
that the selected model appears in the model catalog.

## Choose the AWS context and driver

Use a named AWS profile or Region without editing Terraform:

```bash
npm run quickstart:aws -- --profile personal --region us-west-2
```

For a token-free infrastructure diagnostic, choose the mock explicitly:

```bash
npm run quickstart:aws -- --driver mock
```

Mock mode exercises the same deployment, authentication, Thing lifecycle, queueing, MicroVM, and
artifact paths with deterministic output. It makes no model calls.

## Inspect and remove it

The quickstart is deliberately disposable. Its state and non-secret evidence stay under
`.runtime/aws-quickstart/`; it does not touch a normal `infra/terraform.tfstate` or require a remote
state backend. The full debug log is local, ignored by Git, and intended to make a failed stage
inspectable without filling the normal terminal path with thousands of Terraform lines.

```bash
npm run quickstart:aws -- status
npm run quickstart:aws -- sync-auth
npm run quickstart:aws -- destroy
```

These commands reuse the profile, Region, and environment stored by setup; explicit flags can
override a stored profile if its credentials were renamed or replaced. `status` reports
`incomplete` when setup stopped after confirmation but before the final result, otherwise it reruns
deployment diagnostics and reads the exact Thing. `sync-auth` validates and replaces the encrypted
AWS copy after a local re-login and repeats the credential-risk confirmation. `destroy` confirms
the target, terminates any
remaining MicroVM for this image, destroys only the quickstart state, then fails
unless Terraform state is empty, no MicroVM remains active, and the disabled customer-managed KMS
key is in AWS's mandatory `PendingDeletion` window. It also removes the quickstart-managed Codex
credential secret; an ARN supplied with `--codex-auth-secret-arn` remains operator-managed. Those
postchecks are appended to the local result record.

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
- An interrupted setup after the confirmation may leave exact resources in the quickstart state.
  Run `npm run quickstart:aws -- status`, then `npm run quickstart:aws -- destroy`; both reuse the
  saved identity context. Do not delete the state or context file first.

The quickstart introduces one complete Thing lifecycle. Continue with [Things](things.md), then
add [accounts and permissions](plugins.md) or the [deeper agent controls](agents.md) only when the
task needs them.
