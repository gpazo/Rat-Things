# Development, deployment, and migration

This is the host/operator path for installing and maintaining an independent Rat Things deployment.
Consumers of an existing deployment should start with the [operating model](operating-model.md)
instead; they do not need Terraform, Docker, or access to the runtime account.

For the smallest fresh-clone deployment and a measured real-Codex Thing, start with the
[AWS-ready ten-minute quickstart](quickstart.md). It deliberately omits accounts, VPC/NAT, schedules, and
public sharing. Return here when choosing a longer-lived installation shape.

## Prerequisites

- Node.js 22.20+, npm, and Git.
- Docker with Compose for LocalStack and Buildx for the opt-in ARM64 image canary.
- Terraform 1.5+ and AWS credentials for infrastructure work.
- GitHub CLI authenticated for the one-command GitHub webhook path.
- A Region and quota that support AWS Lambda MicroVMs, plus a currently `AVAILABLE` managed
  `al2023-1` base-image version.
- A local `codex login` with ChatGPT, or Bedrock access, only for real local driver tests. `npm ci`
  installs the same pinned CLI version used in the MicroVM image.

There is no worker-container build, ECR push, or ECS cluster. A deployment used only for one-shot
Runs needs no customer VPC. Enabling S3 Files creates a dedicated VPC, mount target, network connector, and NAT gateway for
durable conversations, so tear disposable stacks down promptly.

## Local workflow

```bash
npm ci
npm run check
npm run smoke:local
```

`smoke:local` validates a v1 request and runs the deterministic mock driver in the current process.
It does not create AWS state, launch a MicroVM, send a notification, or call a model.

For the disposable local integration path:

```bash
npm run test:e2e:localstack
npm run test:e2e:microvm-image
```

LocalStack owns S3, DynamoDB/Streams, SQS, EventBridge, Secrets Manager, and related event routing.
The suite also validates the durable conversation table and S3 bodies through prioritized mailbox,
lease, progress, checkpoint/resume, and completion operations. Handlers and the mock runner execute
on the host because LocalStack does not implement the Lambda MicroVM APIs or lifecycle. WireMock's
Fixture CRM rejects an invalid key, verifies two permission-distinct accounts, and serves the
same-plugin multi-account Thing path without using a customer provider account. See
[`testing/README.md`](../testing/README.md).

The image canary packages and builds the real `linux/arm64` MicroVM context, validates lifecycle
startup through the root/host path, proves the cgroup eBPF policy denies UID 10001 through both
loopback and the guest interface, proves an unrelated external service on port 8080 remains
reachable, launches the bundled Chromium against a public page, captures a screenshot, and rejects
loopback navigation. It does not provision a Lambda MicroVM or replace the disposable-AWS suite.

Focused local runs are also available:

```bash
npx tsx src/cli.ts local --driver mock --prompt "Return the local marker"
npm run codex:login
npm run rat-things -- local "Summarize this repository"
```

The [subscription onboarding guide](codex-subscription.md) covers the shortest path, headless login,
credential storage, and troubleshooting. Local Codex runs default to `chatgpt`, select the built-in
OpenAI provider, and reuse the account cached by `codex login` on this device. Explicit
`--codex-auth bedrock` mints a short-term token from the active AWS identity unless
`AWS_BEARER_TOKEN_BEDROCK` is already present. The equivalent durable setting is
`CODEX_AUTH_MODE=chatgpt|bedrock`; it is not part of the run API and cannot be chosen by callers.
Leave `CODEX_CHATGPT_MODEL` empty to use the signed-in account's default, or set it to an account
model ID. `DEFAULT_MODEL` remains the Bedrock deployment default.
`--events` prints the complete JSONL protocol stream, including command/tool execution records and
token usage, so a canary can prove more than final-message delivery.
For an intentional local command-egress canary, add `--network` and choose the inner sandbox you
want. Local runs default to no network. `workspace-write` maps the flag to Codex's
`sandbox_workspace_write.network_access`; `read-only` carries the same explicit network selection in
its App Server sandbox policy.

The example request contains a deliberately nonexistent repository. Copy it and replace the URL/ref
before using it remotely.

For the shortest signed external trigger and threaded response path, use the
[GitHub webhook onboarding helper](github-webhook-onboarding.md):

```bash
npm run webhook:github -- --repo OWNER/REPOSITORY
```

The helper packages and applies this same Terraform root, but keeps secret values out of Terraform
inputs and state. It writes an ignored `infra/github-onboarding.auto.tfvars.json` containing only
secret ARNs and non-sensitive settings.

## Terraform deployment

`infra/modules/agent-runner` is the reusable module; `infra/` is the minimal root. Terraform uses
the standard AWS provider plus the pinned AWS Cloud Control provider for the MicroVM image resource.
Configuration accepts secret **ARNs**, never secret values or Workflow URLs.

Package and configure:

```bash
npm ci
npm run check
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Replace or remove all example secret ARNs. For a token-free first smoke test, retain:

```hcl
environment                      = "dev"
default_agent_driver             = "mock"
allow_agent_aws_credential_chain = false
allowed_sandbox_modes            = ["read-only", "workspace-write"]
default_sandbox_mode             = "read-only"
default_agent_network_access     = false
enable_microvm                   = true
microvm_base_image_version       = "<available pinned version>"
enable_s3_files                  = true
enable_detailed_api_metrics      = false
force_destroy_data               = false
```

Then deploy:

```bash
terraform -chdir=infra init
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra validate
terraform -chdir=infra plan -out=dev.tfplan
terraform -chdir=infra apply dev.tfplan
```

Review the target account/Region, public webhook routes, `iam:PassRole`, the isolated
`lambda:PassNetworkConnector` wildcard action, retention, logging, quotas, and deletion settings.
Image creation can take several minutes.

### Enable a self-hosted OAuth provider

OAuth is opt-in per installed plugin and does not require a central Rat service:

1. Apply once with `integration_oauth_app_secret_arns = {}`.
2. Read `terraform -chdir=infra output -raw oauth_callback_url` and register that exact HTTPS
   redirect with the provider application.
3. Put `{"client_id":"...","client_secret":"..."}` in a Secrets Manager secret in the stack
   Region. Do not put either value in Terraform state.
4. Add `plugin-id = "SECRET_ARN"` to `integration_oauth_app_secret_arns`, apply again, and confirm
   `GET /v1/integrations/plugins` reports `oauthInstallation.status = configured`.
5. Use the desktop Connections page or
   `rat-things connect PLUGIN --oauth --wait --access read-only`. Omit `--wait` when another
   operator will open the URL and the initiating shell should return immediately.

For Slack, request bot scopes `app_mentions:read`, `chat:write`, and `reactions:write` plus user
scope `search:read`, reinstall after scope changes, and use `--access read-write` when that
Connection will service trusted source-thread delivery. Configure the Events request URL from
`webhook_urls.slack`, subscribe to `app_mention`, then bind the verified workspace without copying a
team ID:

```bash
rat-things connect slack --oauth --wait --access read-write --alias slack-work
rat-things slack-events slack-work --profile read-only --json
```

The resulting bot and delegated-user token families share one owner credential but expire and
refresh independently. Search uses only the user token and therefore inherits that user's Slack
visibility; posts, replies, reactions, and provider identity use the bot token.

Authorization state expires after ten minutes and is one-time. If the provider rejects consent or
the callback page reports failure, start again. Token refresh is automatic only when the provider
issues both an expiry and refresh token; otherwise reconnect after expiry. Removing an app secret
ARN prevents new authorizations and future refresh but does not silently broaden or reassign an
existing connection. The same Terraform input configures the control plane and the MicroVM refresh
broker. Only the ARN map enters the image configuration; the execution role has `GetSecretValue`
only for the declared application secrets, while issued connection credentials remain in their
owner-scoped Secrets Manager path.

By default a dedicated operator-plane Lambda scans a rotating bounded slice every 15 minutes and
re-verifies health older than 60 minutes. It has no API route, agent tool, run submission authority,
or MicroVM access. Configure `enable_connection_health_monitor`,
`connection_health_schedule_expression`, `connection_health_stale_minutes`,
`connection_health_check_limit`, and `connection_health_check_concurrency` when provider limits or
deployment size require a different cadence.

The live-E2E deploy helper reloads saved runtime configuration before updating an existing
deployment. OAuth app ARNs, webhook toggles/signing-secret paths, the selected driver, and S3 Files
settings therefore survive a MicroVM-only redeploy unless an explicit environment variable
overrides them.

MicroVM builds and one-shot runs use AWS-managed internet egress. S3 Files is VPC-mounted, so
persistent conversation runs use the Terraform-managed network connector, private subnet, S3 and
DynamoDB endpoints, and NAT gateway for public Git/model access. Set `enable_s3_files=false` only
when native workspace/app-server restoration across replacement VMs is not required.

Review the [measured AWS spend and per-unit cost model](costs.md) before choosing that setting. The
optional NAT gateway and public IPv4 address create an approximately $36/month idle floor in
`us-west-2`; the default 4-GB/2-vCPU MicroVM itself costs about $0.0042 only for each active minute,
before snapshots and model tokens. Activate billing allocation tags and a project budget before the
first shared or persistent deployment.

Both low-traffic SQS consumers dispatch available records immediately; they retain a batch size of
five for bursts without a configured batching window. CloudWatch Embedded Metric Format records
queue delay and processing duration using only deployment and component dimensions. Per-route API
Gateway metrics remain available through `enable_detailed_api_metrics=true`, but are off by default
to avoid paying for idle route cardinality.

The 2026-08-16 live canary measured 27.45 seconds from a cold message to the agent runner, including
24.11 seconds from AWS's reported MicroVM start to the runner, and 1.99 seconds from a warm message
to the resumed runner. See the [two-turn publication measurement](costs.md#two-turn-publication-measurement)
for the full latency, state-footprint, NAT, token, and list-cost breakdown.

## Remote mock smoke test

Build the CLI and configure it from Terraform output:

```bash
npm run build
export RAT_THINGS_API_URL="$(terraform -chdir=infra output -raw api_endpoint)"
export AWS_REGION="<stack region>"

npm run rat-things -- doctor
npm run rat-things -- doctor --json
npm run rat-things -- submit \
  --driver mock \
  --backend microvm \
  --sandbox read-only \
  --idempotency-key "dev-microvm-smoke-001" \
  --prompt "Return the remote MicroVM smoke-test marker" \
  --wait \
  --output
```

Remote CLI requests use SigV4 for API Gateway. The identity should have `execute-api:Invoke` only
for the intended stack/stage. Never enable unsigned mode against deployed infrastructure.

Exercise and inspect the rest of the control surface:

```bash
npm run rat-things -- list --limit 10
npm run rat-things -- get RUN_ID
npm run rat-things -- artifact RUN_ID events
npm run rat-things -- cancel RUN_ID
```

Create and validate the public facade before publishing scheduled work:

```bash
npm run rat-things -- thing-release --file examples/thing-create.json
npm run rat-things -- thing-run THING_ID --idempotency-key deployment-production-001
```

`doctor` checks deployment discovery and authenticated control access. Thing definitions live in
the `definition_bucket_name` output and lifecycle metadata in `things_table_name`; they are separate
from expiring run artifacts. Never use the local owner-header escape hatch in a deployed stack.

To exercise the same durable mailbox and Lambda MicroVM continuation path used by a chat webhook,
send two headless turns under one owner-scoped conversation name:

```bash
npm run rat-things -- \
  --thread dev-codex-smoke \
  --sandbox workspace-write \
  "Use the shell tool to create marker.txt containing alpha, then read it."

npm run rat-things -- \
  --thread dev-codex-smoke \
  --sandbox workspace-write \
  "Read the existing marker.txt and explain what you remember from the first turn."
```

Each command waits for the exact message's Run to succeed and for completion orchestration to fold
the result into durable context and suspend the session before printing Codex output. Add `--json`
to capture the message and Run IDs, public Run state, and suspended session state. Public responses
intentionally omit private MicroVM and native Codex thread identifiers; trusted operators can
correlate those only through AWS logs and dedicated test evidence. Reuse the exact agent policy on
later turns; it is immutable for the conversation.

For a one-shot control run, verify exactly one execution ID, successful self-termination,
output/event checksums, terminal state, empty queues/DLQs, provider delivery state, and correlated
logs. A conversation validation must instead verify suspend, authenticated resume on the same ID,
retained workspace/Codex thread, and eventual termination or expiry cleanup.

## Disposable live-AWS gate

Use the separate state under `testing/aws` when the goal is deploy, validate, and immediately remove
everything:

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<available pinned version>" \
npm run test:e2e:aws
```

The harness exercises real API Gateway/Lambda/IAM/KMS, public discovery and schemas, the Thing and
headless conversation APIs, a disposable provider API with two verified accounts, signed
GitHub/GitLab/Teams ingress, a pinned repository checkout inside the MicroVM, durable
definitions/artifacts/state/events, captured Teams egress, failure queues, one-shot
self-termination, and a two-turn Teams conversation that suspends and resumes the same MicroVM
through its AWS-authenticated continuation endpoint. The Thing scenario verifies immutable
KMS-encrypted definitions, provider/broker/profile/Thing permission intersection, idempotent
dispatch, lifecycle changes, CLI rotation, revocation, and absence of credential values. The mock
suite also validates expired-session replacement and coordinator crash-window repair. Its opt-in
real-Codex probes restore workspace/thread state and perform one read plus one statically admitted write
against exact Fixture CRM accounts, with exactly-one provider-side mutation. The harness destroys
the tagged stack from an exit trap. LocalStack cannot replace that isolation/lifecycle test. See
[`testing/aws/README.md`](../testing/aws/README.md).

Add the bounded two-turn real-Codex persistence probe before teardown with:

```bash
AWS_E2E_REAL_CODEX=true \
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<available pinned version>" \
npm run test:e2e:aws
```

## Real Codex canary

Only after the mock path passes:

1. Use a dedicated non-sensitive owner and repository with outbound delivery disabled.
2. Keep `allow_agent_aws_credential_chain=false`. The trusted worker mints a bounded short-term
   Bedrock token from its execution role and passes only that token to the unprivileged Codex child.
   A scoped key in Secrets Manager remains an explicit override.
3. Confirm the bundled CLI/configuration and model/provider settings.
4. Start with no repository, then a pinned public read-only repository, then a private read-only
   repository using a clone-only secret.
5. Validate output/events, cancellation, timeout, logs, credential absence, latency, quota, and cost.
6. Enable one result destination only after the execution path is understood.

The deployed MicroVM path intentionally remains `CODEX_AUTH_MODE=bedrock`. Do not copy a personal
`~/.codex/auth.json` into the image or a run: it contains reusable account tokens and the
repository-controlled agent process could read or exfiltrate them. ChatGPT account mode is for
trusted local execution on the signed-in device. A future remote account-auth mode needs a brokered
credential boundary or a separately approved trusted-runner design.

Codex behavior and authentication change over time; verify the pinned CLI against the official
[non-interactive guide](https://developers.openai.com/codex/noninteractive),
[CLI reference](https://developers.openai.com/codex/cli/reference), and
[authentication guide](https://developers.openai.com/codex/auth) before upgrading.

## Webhooks and chat

Enable one adapter at a time by supplying its ingress-secret ARN and following
[channel configuration](channels.md). Use a disposable repository/team and inspect provider delivery
history plus CloudWatch correlation.

For shadow observation, use `default_delivery_destinations="none"`. This prevents a second provider
post but does not prevent agent/model cost. Keep the default driver `mock` until a real-driver canary
is intentional.

Comments/notes require the configured non-empty trigger and outbound replies carry a runtime marker;
the adapters ignore marked replies and provider-declared bot authors. These are loop guards, not
authorization. Add repository/actor policy and cost limits before production.

Teams should use the outgoing-webhook/Workflow combination only as a bridge. The production Teams
SDK/Bot gateway is a separate milestone that can reuse this run subsystem.

## Migration from `indubitably-serverless`

Do not import old Terraform state, reuse old tables/queues, or delete the existing webhook/worker
path as part of creating this subsystem. Migration is a parallel-deploy and explicit cutover.

1. Inventory callbacks, owner mapping, credentials, prompts/models, retry behavior, destinations,
   metrics, budgets, and active runs.
2. Deploy Rat Things independently and pass the mock LocalStack and live-AWS gates.
3. Canary a dedicated repository/project with a new webhook secret and compare normalized inputs,
   checkout SHA, output, latency, duplication, and cost.
4. Run a read-only real-driver canary with delivery disabled, then enable one destination.
5. Cut over one webhook or API caller; do not subscribe both systems to result-producing events
   unless duplicate model work and comments are explicitly acceptable.
6. Observe, drain old active runs, expand gradually, and keep the old subsystem intact for the agreed
   rollback period.
7. Decommission the old implementation only as a later project with its own backup, retention,
   deletion, and rollback approval.

Rollback means restoring the provider callback or API base URL to the retained old subsystem. Do not
merge run IDs or replay the same business event without checking for an existing provider response.

## Destruction and retention

`force_destroy_data=false` protects non-empty artifact and definition buckets from Terraform
deletion; it does not retain
DynamoDB, queues, logs, or KMS keys during an approved full destroy. Use reviewed backups and
organization policy for durable environments.

Before destroy, confirm the exact account/Region/workspace/prefix, stop ingress, drain or cancel
active runs, reconcile provider outcomes, and review the full destroy plan. Terraform destruction
does not retract provider posts. Never use broad recursive deletion or Terraform state surgery as a
convenience teardown.
