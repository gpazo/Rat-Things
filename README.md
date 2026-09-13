# Rat Things

Rat Things runs durable cloud agents in your AWS account. Its public execution
contract follows the OpenAI Agents API: Agents, Sessions, Turns, Items,
environments, environment templates, Files, Skills and Vaults. Your account owns
the API service, harness, session state, execution environments and encrypted
storage. Model requests use the provider configured by your deployment.

This is an engineering preview. The migration includes the official SDK models
and execution protocol. Native runtime, deployment and behavioral acceptance are
tracked in the [conformance ledger](plans/agents-api-conformance.md).

## Use the API

Use the Terraform `agents_api_base_url` output and an AWS principal authorized to
invoke the deployment's token issuer. The included transport obtains and refreshes
a scoped bearer credential for the official OpenAI SDK:

```ts
import { createAgentsClient } from './dist/agents-client.mjs';

const client = createAgentsClient({
  baseURL: process.env.RAT_THINGS_AGENTS_API_URL,
  region: process.env.AWS_REGION,
});
const agent = await client.beta.agents.create({
  model: process.env.AGENT_MODEL,
  instructions: 'Answer clearly and concisely.',
});
const session = await client.beta.agents.sessions.create({
  agent_id: agent.id,
  environment: { type: 'none' },
  input: 'Explain the task you can help with.',
});
```

Choose a model allowed by your deployment. Environment templates define managed
workspace setup, network access, files and skills. The upstream `openai_hosted`
discriminator selects a managed environment running in **your AWS account**.
Self-hosted executors connect through the private authenticated relay.

The [Agents API guide](docs/agents-api.md) covers authentication, resources,
continuation, streaming, tools, files, environment connections and current limits.
The [agent operating guide](docs/agents.md) provides a concise entry point.

## Provider events and schedules

Signed GitHub, GitLab, Slack and Teams events resolve an operator-owned Agent
binding. Each event has a durable input receipt; Slack and Teams retain Session
continuity within a sender's thread. Delivery follows root Turn completion and
runs independently of Session execution.

Schedules reference an Agent and environment. They retain occurrence identity,
input templates, time zones and overlap policy without defining another kind of
agent. See [schedules and provider bindings](docs/schedules.md).

Connections retain provider installation, OAuth refresh, grant narrowing and
notification access. Agent-facing tools are explicitly declared on Agents;
notification credentials do not silently add tools.

The former Thing and Routine APIs, executable definitions and CLI commands are
removed. Saved tables remain pending explicit data disposition. The
[cleanup handoff](plans/obsolete-implementation-removal.md) lists the remaining
private implementation cleanup and deployment acceptance work.

## Work locally

```bash
npm ci
npm run check
npm run smoke:local
npm run console:serve
```

The CLI supports `agents`, `sessions`, `environments`, `vaults` and `schedules`.
Use `rat-things agents --help` for canonical resource commands. Local execution,
connection installation, diagnostics and deployment tooling remain available.
Codex is pinned consistently in the npm dependency, MicroVM image and relay image.

The reusable Terraform module is `infra/modules/agent-runner`; `infra/` is its
root example. Build Lambda artifacts before validation. Lambda and MicroVM builds
use ARM64 (`linux/arm64`). Ordinary tests never provision a MicroVM.

## Boundaries

The harness drops the agent process to a separate non-root UID inside a MicroVM.
Worker ingress is private. Provider signatures are checked before parsing, owners
come from trusted identity, clone URLs are HTTPS and host-allowlisted, and state
changes use conditional writes. Prompts and results live in encrypted S3; DynamoDB
holds indexes and references. Credentials remain behind host-side brokers.

Capabilities are fixed before launch. Rat Things has no mid-Turn approval layer;
an operation outside the allowed capabilities remains unavailable.

See [AGENTS.md](AGENTS.md) for contributor boundaries and commands, and the
[documentation](https://gpazo.github.io/Rat-Things/docs/agents-api/) for operation.
