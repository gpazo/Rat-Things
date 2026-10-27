# Can I run the OpenAI Agents API harness in my own AWS account?

Yes, you can run Codex and an OpenAI Agents API-compatible control plane in your own
AWS account with Rat Things. Rat Things deploys its own API service, Codex harness,
isolated workers and durable Session storage. It is an independent implementation
in engineering preview, with documented compatibility limits.

OpenAI's hosted Agents API is a different deployment model. Its
[self-hosted environment option](https://developers.openai.com/api/docs/guides/agents-api/architecture)
moves command execution to your compute while OpenAI operates the harness.
Pointing that service at an AWS sandbox does not move its control plane into your account.

## Separate the harness, sandbox and model

| Component | OpenAI Agents API with a self-hosted sandbox | Rat Things in AWS |
| --- | --- | --- |
| API and harness | OpenAI-managed service | Your Rat Things deployment and Codex process |
| Command environment | Your connected executor | Per-session EC2 or Lambda MicroVM worker, or a connected executor |
| Session history | Managed by OpenAI | Encrypted S3 content and DynamoDB coordination in your account |
| Model inference | OpenAI service | Deployment-configured model provider; self-hosting the harness does not self-host model weights |
| Operations | You operate the connected environment | You operate the deployment, IAM, storage, workers and upgrades |

These OpenAI responsibilities follow its [architecture documentation](https://developers.openai.com/api/docs/guides/agents-api/architecture).
Rat Things' [architecture](../docs/architecture.md) explains its ownership and storage boundaries.
AWS also offers [Bedrock Managed Agents](https://developers.openai.com/api/docs/guides/agents-api/bedrock-managed-agents),
which runs a managed harness and inference in Bedrock. That is another option when
you want an AWS service to operate the harness.

## Connect an application to your deployment

Follow the [AWS quickstart](../docs/quickstart.md) to deploy the Terraform module.
Configure an admitted model and the credentials and tools the Session needs.
Use the deployment's `agents_api_base_url` Terraform output, rather than OpenAI's
hosted endpoint, and authenticate through the Rat Things IAM token issuer.

The repository supplies a client that refreshes short-lived bearer credentials:

```ts
import { createAgentsClient } from './dist/agents-client.mjs';

const client = createAgentsClient({
  baseURL: process.env.RAT_THINGS_AGENTS_API_URL!,
  region: process.env.AWS_REGION!,
});

const session = await client.beta.agents.sessions.create({
  agent: { model: process.env.RAT_THINGS_MODEL! },
  environment: { type: 'none' },
  input: 'Explain the deployment boundaries for this agent.',
});
console.log(session.id);
```

Build the repository first with `npm run build`. This example needs no command
environment. To work with files, configure a managed environment as described in
the [API guide](../docs/agents-api.md). Rat Things retains the upstream wire name
`openai_hosted` for environments it provisions in your AWS account. In this
implementation that name does not select OpenAI-operated compute.

## Current boundaries

The installed `/openapi.json` and `/schemas/agents-api.schema.json` are the contract
for your deployment. Rat Things uses the official OpenAI SDK's resource types;
that does not establish full behavioral parity or OpenAI endorsement. It does not
move existing hosted Sessions into AWS simply by changing a client URL.

Codex and Pi Durable have different tool and environment support. Model requests
go to the configured provider. Workspace recovery requires the appropriate storage
and checkpoint configuration; a saved transcript does not restore arbitrary live
processes. Review [runtime limits](../docs/agent-runtimes.md) and
[durable state](durable-ai-agent-state.md) before choosing a workflow.

## Frequently asked questions

### Is Rat Things an official self-hosted edition of OpenAI's Agents API?

No. It is an independent, open-source control plane that implements the Agents API
resource model using the official SDK. Check the installed schema and documented
limits for compatibility with the operations your application uses.

### Does hosting the harness in AWS keep every model request in my account?

No. The deployment controls the harness, workers and saved state. Inference follows
its configured model provider and that provider's data handling. Select and review
the inference path separately from the execution environment.

## Sources

- [OpenAI Agents API architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [Bedrock Managed Agents](https://developers.openai.com/api/docs/guides/agents-api/bedrock-managed-agents)
- [Rat Things API and compatibility boundaries](../docs/agents-api.md)
- [Rat Things architecture](../docs/architecture.md)
