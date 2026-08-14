# Connect a GitHub webhook

The GitHub golden path reduces Rat Things webhook onboarding to one repository command and one pull
request comment. It preserves the important security boundaries: GitHub signs the raw request,
Secrets Manager holds credentials, the webhook cannot select a model or owner, and the result returns
only to the authenticated source repository and pull-request thread.

## Prerequisites

- Node.js 20+, npm, and Git.
- Terraform 1.5+.
- AWS credentials for an account and Region with Lambda MicroVM access and quota.
- GitHub CLI (`gh`) authenticated to the target repository with permission to manage webhooks.
- For the automatic onboarding credential, repository contents read and issues/pull-request comments
  write access. Repository administration is needed to create the hook.

Lambda MicroVMs are currently supported by this repository in `us-east-1`, `us-east-2`, `us-west-2`,
`ap-northeast-1`, and `eu-west-1`. The helper uses `AWS_REGION`, then `AWS_DEFAULT_REGION`, and
otherwise defaults to `us-west-2`.

## One-command setup

From the repository root:

```bash
npm ci
npm run webhook:github -- --repo OWNER/REPOSITORY
```

The helper first prints the exact GitHub repository, AWS account, Region, execution driver, trigger,
and MicroVM base-image version. Nothing changes until you confirm. Use `--dry-run` to inspect the
workflow without contacting AWS or GitHub:

```bash
npm run webhook:github -- --repo OWNER/REPOSITORY --dry-run
```

After confirmation, the helper:

1. Creates or reuses separate webhook, clone, and notification entries in AWS Secrets Manager.
2. Generates a high-entropy signing secret without printing or placing it in Terraform.
3. Discovers the newest available managed `al2023-1` Lambda MicroVM image version.
4. Writes ignored Terraform variables containing only secret ARNs and non-sensitive settings.
5. Packages the Lambda and MicroVM artifacts and applies `infra/`.
6. Creates or updates a GitHub webhook for pull-request and issue-comment events.
7. Stores only the repository, hook ID, URL, ARNs, and trigger under ignored `.runtime/` metadata.

The operation is rerunnable. Existing named secrets and the previously recorded repository hook are
updated instead of intentionally creating a new integration.

## Trigger the first response

The safe default is `--driver mock`. It spends no model tokens but proves signature verification,
normalization, repository checkout, MicroVM execution, terminal events, delivery fencing, and the
final GitHub comment.

Open a pull request and comment:

```text
@rat-things summarize the riskiest part of this change
```

GitHub receives an immediate `202` acknowledgement. Rat Things posts the terminal result back to the
same pull-request thread asynchronously.

Inspect the registered hook and most recent GitHub delivery:

```bash
npm run webhook:github:status
```

The status command reads non-secret local metadata and reports whether the hook is active plus the
latest delivery event, HTTP status, and timestamp.

## Turn on the real Codex driver

AWS webhook workers do not receive the reusable credentials cached by `codex login`. That is
intentional: repository-controlled code inside an unattended worker must not be able to steal a
personal ChatGPT session.

For a real agent response, confirm Amazon Bedrock model access in the target Region, then rerun:

```bash
npm run webhook:github -- \
  --repo OWNER/REPOSITORY \
  --driver codex
```

The deployed runner mints a bounded short-term Bedrock bearer token from its execution role. Bedrock
model-token charges are separate from Lambda MicroVM compute. The webhook cannot change this driver
or credential policy.

## Credential handling

For evaluation, the helper can reuse the current `gh auth token` while placing it in separate clone
and notification secrets. This minimizes setup, but the two entries still contain the same authority.
The helper prints a warning when it uses this convenience path.

For a production-shaped test, provide independently scoped fine-grained tokens without putting them
on the command line:

```bash
export RAT_THINGS_GITHUB_CLONE_TOKEN="<contents-read token>"
export RAT_THINGS_GITHUB_NOTIFY_TOKEN="<issues-write token>"
npm run webhook:github -- --repo OWNER/REPOSITORY
unset RAT_THINGS_GITHUB_CLONE_TOKEN RAT_THINGS_GITHUB_NOTIFY_TOKEN
```

The helper transfers secret values to Secrets Manager through mode-`0600` temporary files, deletes
those files on exit, and never writes values to Terraform configuration, Terraform state, `.runtime/`
metadata, logs, or the GitHub webhook status output.

Production should replace static tokens with short-lived GitHub App installation credentials. That
remains a documented maturity gap; the one-command helper does not make a broad personal token
least-privileged merely by copying it into separate secrets.

## Useful options

```text
--driver mock|codex
--trigger TEXT
--region REGION
--profile AWS_PROFILE
--environment NAME
--microvm-base-image-version VERSION
--dry-run
--yes
```

Use a distinct environment and trigger for every dev, staging, and production hook. `--yes` is for
reviewed automation and skips only the helper's confirmation; it does not relax AWS, GitHub, or
Terraform authorization.

## Troubleshooting

1. Run `npm run webhook:github:status` and inspect the latest GitHub HTTP status.
2. Confirm `gh repo view OWNER/REPOSITORY` works and the authenticated identity can manage hooks.
3. Confirm the selected AWS account has Lambda MicroVM access, service quota, IAM permissions, and
   Bedrock model access when `--driver codex` is selected.
4. A GitHub ping is validly signed but intentionally ignored with HTTP `202`; use a supported pull
   request event or an `@rat-things` pull-request comment to create a run.
5. A `401` means the GitHub hook and Secrets Manager signing values differ. Rerun onboarding to
   reuse the stored signing secret and update the hook.
6. A successful run with a failed comment normally means the notification token lacks issues-write
   permission or the notifier failure queue needs inspection.

For lower-level behavior and manual production configuration, see [Channel adapters](channels.md).
