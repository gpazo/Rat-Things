# AWS and Agents quickstart

Rat Things keeps its API, harness, session state and execution in your AWS account.
Use the [deployment guide](development-and-deployment.md) to configure the Terraform
module, model credentials, ARM64 runtime image and Agents HTTP service. Package
Lambda artifacts before Terraform validation or deployment. Deployment creates
AWS resources; ordinary local checks do not provision MicroVMs.

## Automated setup

The setup helper deploys the AWS backend, creates an Agent with the selected
model, and completes two Turns in one Session. It checks the saved assistant
Items, deletes the disposable Session to stop its harness, and leaves the Agent
available for new work. Setup provisions AWS resources and invokes the model.

```bash
npm run quickstart:aws -- --model YOUR_ADMITTED_MODEL
```

For ChatGPT authentication, setup requires explicit consent before copying the
device's renewable Codex credentials into your AWS Secrets Manager. `--model`
selects a model admitted by that credential and deployment. Use `--auth bedrock`
with a configured Bedrock model for AWS model authentication instead.

`--dry-run` describes setup without deploying. Existing-deployment status,
credential synchronization and teardown commands retain the deployment's saved
AWS identity. The local deterministic smoke test is `npm run smoke:local`;
a mock driver cannot prove an Agents deployment.

The helper uses the Lambda URL transport when a dedicated Agents HTTP service is
not configured. Large uploads, long-lived SSE and executor connections need the
[public transport deployment](agents-api.md#deploy-the-public-transport).

## Connect an installed deployment

Set the Agents endpoint from `agents_api_base_url` and select an admitted model:

```bash
export RAT_THINGS_AGENTS_API_URL="https://your-agents-endpoint/v1"
export AWS_REGION="us-west-2"
export RAT_THINGS_MODEL="your-configured-model"

npm run rat-things -- sessions create --model "$RAT_THINGS_MODEL" \
  --input "Explain Agents, Sessions and Turns." --stream
```

The CLI obtains an owner-scoped API key using the workstation's AWS identity.
The identity must be allowed to invoke the deployment's token issuer. Model
requests use the deployment's configured provider and credentials.

For reusable work, save an Agent request containing `model`, `name`,
`instructions` and declared `tools`, then create it:

```bash
rat-things agents create --file agent.json
rat-things sessions create --agent-id agent_example --input "Begin the review."
rat-things sessions turns sess_example
rat-things sessions items sess_example
rat-things sessions send sess_example --input "Also include the rollout plan."
```

The default CLI Session environment is `none`. Use a standard Session JSON request
with an environment template when commands or a filesystem are required. Agent
configuration is snapshotted when the Session is created.

Use the [SDK guide](agents-api.md) for complete resource examples and
[schedules and provider bindings](schedules.md) for automated input. Set
`RAT_THINGS_API_URL` to the separate control endpoint for schedule and connection
installation commands.
