# AWS and Agents quickstart

New to Rat Things? [Start on this computer](local-workspace.md) for durable
conversations without an AWS account. Return here when you need managed computers,
provider integrations, or work that runs while your computer is off. The desktop
and resource APIs stay familiar when you connect your AWS workspace.

Rat Things keeps its API, harness, session state and execution in your AWS account.
Use the [deployment guide](development-and-deployment.md) to configure the Terraform
module, model credentials, ARM64 runtime image and Agents HTTP service. Package
Lambda artifacts before Terraform validation or deployment. Deployment creates
AWS resources; ordinary local checks do not provision MicroVMs. Packaging requires the
patched Linux ARM64 Codex artifact described in the [contributor guide](../testing/README.md#agents-api-native-compatibility-gate). Do not substitute the stock npm binary.

## Automated setup

Rat Things supports [Codex and Pi Durable](agent-runtimes.md). For Pi Durable,
follow [the Bedrock setup guide](../guides/run-pi-durable-on-bedrock.md), which
configures the Terraform model catalog and creates a Pi Session.

The automated setup helper uses Codex. It deploys the AWS backend, creates an Agent with the selected
model, and completes two Turns in one Session. It checks the saved assistant
Items, deletes the disposable Session to stop its harness, and leaves the Agent
available for new work. Setup provisions AWS resources and invokes the model.

```bash
npm run quickstart:aws
```

The default uses paid Bedrock inference through private AWS endpoints. Use `--model`
to select another admitted model, and `--profile` or `--region` to select your AWS
identity and location. The helper installs pinned Node dependencies and builds a
missing worker artifact with ARM64-capable Docker. The initial build can take time;
a valid artifact supplied through `CODEX_RUNTIME_ARTIFACT` is reused.

PrivateLink endpoints, compute, storage and model usage incur AWS charges separately
from your subscription. Runtime internet access is denied by default. To use ChatGPT
on AWS, select `--auth chatgpt --model YOUR_ADMITTED_MODEL` and supply reviewed provider
IPv4 destinations with `--https-egress-cidrs`. Credential copying still requires
explicit consent. Other external services also need configured HTTPS destinations;
see [runtime egress](../infra/README.md).

`--dry-run` describes setup without deploying. Existing-deployment status,
credential synchronization and teardown commands retain the deployment's saved
AWS identity. The local deterministic smoke test is `npm run smoke:local`;
a mock driver cannot prove an Agents deployment.

The helper uses the Lambda URL transport when a dedicated Agents HTTP service is
not configured. Large uploads, long-lived SSE and executor connections need the
[public transport deployment](agents-api.md#deploy-the-public-transport).

### Optional spending alert

Before deploying, you can choose a monthly dollar amount and email recipients:

```bash
npm run quickstart:aws -- --budget-usd 50 --budget-alert-emails you@example.com
```

Replace the example amount and address. Supply both options or omit both; alerts
are disabled by default. `--budget-alert-emails` accepts up to ten comma-separated
addresses. Add `--dry-run` to review the configuration without AWS changes.

This creates an AWS Budgets email alert when reported actual monthly costs exceed
the amount in USD. It includes all services and regions in the selected AWS account,
including other workloads. It does not allocate shared costs to Rat Things owners,
block execution or affect your local ChatGPT subscription. AWS billing data and
notifications are delayed, so spending can exceed the amount before an alert arrives.
See [costs and budget alerts](costs.md#optional-budget-alerts) for the scope and Terraform setup.

## Connect an installed deployment

From a source checkout, run `npm ci` and invoke the CLI with `npm run rat-things --`.
Examples elsewhere use the shorter `rat-things` command; to install that command
on your PATH, run `npm run build && npm link` from the checkout.

Set the Agents endpoint from `agents_api_base_url` and select an admitted model:

```bash
export RAT_THINGS_AGENTS_API_URL="https://your-agents-endpoint/v1"
export AWS_REGION="us-west-2"
export RAT_THINGS_MODEL="your-configured-model"

npm run rat-things -- sessions create --model "$RAT_THINGS_MODEL" \
  --input "Explain Agents, Sessions and Turns." --stream
```

If you use a named AWS profile, also set `AWS_PROFILE` to that profile's name.
The CLI obtains an owner-scoped API key using the workstation's AWS identity.
The identity must be allowed to invoke the deployment's token issuer. Model
requests use the deployment's configured provider and credentials.

To select Pi Durable on a configured deployment, first run
`npm run rat-things -- agents models --runtime pi`, then add `--runtime pi` to
`sessions create` with an admitted Bedrock model. The desktop offers the same
choice in its Runtime picker.

For reusable work, save an Agent request containing `model`, `name`,
`instructions` and declared `tools`, then create it:

```bash
npm run rat-things -- agents create --file agent.json
npm run rat-things -- sessions create --agent-id agent_example --input "Begin the review."
npm run rat-things -- sessions turns sess_example
npm run rat-things -- sessions items sess_example
npm run rat-things -- sessions send sess_example --input "Also include the rollout plan."
```

The default CLI Session environment is `none`. Use a standard Session JSON request
with an environment template when commands or a filesystem are required. Agent
configuration is snapshotted when the Session is created.

Use the [SDK guide](agents-api.md) for complete resource examples and
[schedules and provider bindings](schedules.md) for automated input. Set
`RAT_THINGS_API_URL` to the separate control endpoint for schedule and connection
installation commands.
