# Development and deployment

This is the host/operator path for installing and maintaining an independent Rat Things deployment.
Consumers of an existing deployment should start with the [operating model](operating-model.md)
instead; they do not need Terraform, Docker, or access to the runtime account.

For the smallest fresh-clone deployment and a runnable Agent and Session, start with the
[AWS quickstart](quickstart.md). It deliberately omits accounts, VPC/NAT, schedules, and
public sharing. Return here when choosing a longer-lived installation shape.

## Prerequisites

- Node.js 22.20+, npm, and Git.
- Docker with Compose for LocalStack and Buildx for the patched Linux ARM64 runtime and image canaries.
- A verified patched native artifact for packaging; build or import it using
  [`testing/README.md`](../testing/README.md#agents-api-native-compatibility-gate).
- Terraform 1.15.8, matching CI, and AWS credentials for infrastructure work.
- GitHub CLI authenticated for the one-command GitHub webhook path.
- A Region and quota that support AWS Lambda MicroVMs, plus a currently `AVAILABLE` managed
  `al2023-1` base-image version.
- A local `codex login` with ChatGPT, or Bedrock access, only for real local driver tests. `npm ci`
  installs the same pinned CLI version used in the MicroVM image.

The MicroVM service builds its image from the packaged source ZIP. Dedicated EC2 workers
require a pinned ARM64 container image and AMI. The module also creates an ECR repository;
configuring `environment_relay_image` enables the Agents HTTP and relay Fargate services
with their own VPC and load balancer. Enabling S3 Files creates a separate VPC, mount target,
NAT gateway and, when MicroVM is enabled, a network connector. These optional services
add standing costs even without active Sessions.

## Local workflow

```bash
npm ci
npm run check
npm run smoke:local
```

`smoke:local` validates a v1 request and runs the deterministic mock driver in the current process.
It does not create AWS state, launch a MicroVM, send a notification, or call a model.

Contributor test commands and harness behavior are documented in
[`testing/README.md`](../testing/README.md) and the
[live AWS harness](../testing/aws/README.md).

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
Leave `CODEX_CHATGPT_MODEL` empty to use the signed-in workspace's default, or set it to an account
model ID. `DEFAULT_MODEL` is used only by an explicitly selected Bedrock deployment.
For a deployed native-console model picker, configure `codex_chatgpt_model_ids` with the exact IDs
verified for the deployment-owned workspace credential. A pinned `codex_chatgpt_model` becomes a
singleton catalog when no list is supplied. An unconfigured catalog remains unavailable rather than
guessing from Codex support metadata or a different local login.
`--events` prints the complete JSONL protocol stream, including command/tool execution records and
token usage. To allow networking in a local Run, add `--network` and choose the inner sandbox.
Local runs default to no network. `workspace-write` maps the flag to Codex's
`sandbox_workspace_write.network_access`; `read-only` carries the same explicit network selection in
its App Server sandbox policy.

For signed GitHub triggers, configure the deployed webhook and an owned Agent/environment
binding using [GitHub webhook setup](github-webhook-onboarding.md). The binding is required
before a provider event can start a Session.

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

Replace or remove all example secret ARNs and configure credentials for an admitted model.
Use `npm run smoke:local` for an offline smoke test. Deployed Sessions run Codex or
Pi Durable and invoke the configured model when input arrives. Codex is the default;
Pi requires its own approved Bedrock catalog. Start with conservative capabilities:

```hcl
environment                      = "dev"
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
5. Run `rat-things connect PLUGIN --oauth --wait --access read-only`. Omit `--wait` when another
   operator will open the URL and the initiating shell should return immediately.

For Slack, request bot scopes `app_mentions:read`, `chat:write`, and `reactions:write` plus user
scope `search:read`, reinstall after scope changes, and use `--access read-write` when that
Connection will service trusted source-thread delivery. Configure the Events request URL from
`webhook_urls.slack`, subscribe to `app_mention`, then bind the verified workspace without copying a
team ID:

```bash
rat-things connect slack --oauth --wait --access read-write --alias slack-work
rat-things slack-events slack-work --agent-id agent_example --json
```

Replace `agent_example` with an owned saved Agent. Add `--environment-template TEMPLATE_ID`
when it needs an execution environment; the default is `none`. The binding does not turn
the notification connection into an Agent tool.

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

MicroVM builds and runs without S3 Files use AWS-managed internet egress. MicroVM
Sessions with S3 Files use the managed network connector, private subnet, service
endpoints and NAT gateway. EC2 workers also require S3 Files. Persistent storage is
required for native checkpoint adoption and forks; storage alone does not guarantee
workspace recovery after an unplanned worker loss.

Review the [cost model](costs.md) before choosing storage and transport settings.
NAT gateways, public IPv4 addresses, Fargate services and load balancers can incur
charges while no Turn is running. Use current rates for the deployment Region, and
activate billing allocation tags and a project budget before shared use.

The Run dispatch queue processes batches of up to five records without a batching
window. The Agents outbox uses a FIFO queue with one record per invocation. Dispatcher
CloudWatch Embedded Metric Format records queue delay and processing duration using only deployment and component dimensions. Per-route API
Gateway metrics remain available through `enable_detailed_api_metrics=true`, but are off by default
to avoid paying for idle route cardinality.

A cold launch must boot the MicroVM and prepare storage before the selected runtime initializes. A resumed
conversation can reuse mounted storage and native agent state. Diagnose these phases separately
using the [startup runbook](runbook.md#slow-conversation-startup-or-codex-initialization).

## Create your first remote Session

Build the CLI and configure the Agents endpoint from Terraform output. This
invokes the deployment's admitted model and provisions execution on demand.

```bash
npm run build
export RAT_THINGS_AGENTS_API_URL="$(terraform -chdir=infra output -raw agents_api_base_url)"
export AWS_REGION="<stack region>"
npm run rat-things -- sessions create --model YOUR_ADMITTED_MODEL --input "Draft a release checklist."
npm run rat-things -- sessions turns sess_example
npm run rat-things -- sessions items sess_example
npm run rat-things -- sessions send sess_example --input "Continue the review."
npm run rat-things -- sessions delete sess_example
```

Session deletion closes its private harness and removes API access to its history
and artifacts. Export anything you need first. Cancellation stops the current Turn
while preserving the Session. For command execution, provide a standard Session
request with a managed environment and declared tools; see [Agents API](agents-api.md).

Connection installation, [schedules](schedules.md) and explicit publication use
the separate IAM-authenticated control endpoint in `RAT_THINGS_API_URL`. `doctor`
checks discovery and control access. Never enable unsigned mode or the local owner
header against a deployed stack. Use `npm run smoke:local` for deterministic mock
execution without deploying or invoking a model.

## Configure model authentication

Keep host AWS credentials separate from agent authority with
`allow_agent_aws_credential_chain=false`. The default Codex ChatGPT path reads a validated file-based
login from `codex_auth_file_secret_arn`; Bedrock uses the generated runtime role's model access.

The deployed Codex path defaults to `CODEX_AUTH_MODE=chatgpt`. It resolves the auth-file secret
inside the trusted worker, writes a private runtime `auth.json`, runs Codex with the built-in OpenAI
provider, persists validated refresh rotation, and removes the runtime file. Never bake the file
into an image or place it in a Run, state record, log, or Terraform value. Same-UID agent code can
read it during execution, and persistent S3 Files may carry the temporary copy; read the
[credential lifecycle](codex-subscription.md#credential-risk-and-lifecycle) before enabling the bridge. Set
`codex_auth_mode = "bedrock"` and an exact Bedrock model allowlist only when a deployment
deliberately chooses that provider.

Pi Durable uses Bedrock Converse independently of `codex_auth_mode`. Configure
`pi_bedrock_model_ids`, `pi_bedrock_default_model`, and exact
`pi_bedrock_inference_resource_arns`. The host mints short-term Bedrock tokens;
the Pi process receives no execution-role credentials. Managed Pi environments
also require S3 Files and Session checkpoints. Follow
[Pi inference configuration](../infra/README.md#enable-pi-inference) and the
[Pi setup guide](../guides/run-pi-durable-on-bedrock.md).

Codex behavior and authentication change over time; verify the pinned CLI against the official
[non-interactive guide](https://developers.openai.com/codex/noninteractive),
[CLI reference](https://developers.openai.com/codex/cli/reference), and
[authentication guide](https://developers.openai.com/codex/auth) before upgrading.

## Webhooks and chat

Enable one adapter at a time by supplying its ingress-secret ARN and following
[channel configuration](channels.md). Use a disposable repository/team and inspect provider delivery
history plus CloudWatch correlation.

For shadow observation, use `default_delivery_destinations="none"` where a binding does not
set explicit destinations. This suppresses the default provider reply but does not prevent
agent/model cost. Deployed Sessions use Codex or Pi Durable; `mock` is a local test driver.

Comments/notes require the configured non-empty trigger and outbound replies carry a runtime marker;
the adapters ignore marked replies and provider-declared bot authors. These are loop guards, not
authorization. Add repository/actor policy and cost limits before production.

Teams should use the outgoing-webhook/Workflow combination only as a bridge. The production Teams
SDK/Bot gateway is a separate milestone that can reuse this run subsystem.

## Destruction and retention

`force_destroy_data=false` protects non-empty artifact and definition buckets from Terraform
deletion; it does not retain
DynamoDB, queues, logs, or KMS keys during an approved full destroy. Use reviewed backups and
organization policy for durable environments.

Before destroy, confirm the exact account/Region/workspace/prefix, stop ingress, drain or cancel
active runs, reconcile provider outcomes, and review the full destroy plan. Terraform destruction
does not retract provider posts. Never use broad recursive deletion or Terraform state surgery as a
convenience teardown.
