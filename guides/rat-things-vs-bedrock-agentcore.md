# Rat Things vs Amazon Bedrock AgentCore

Rat Things is an open-source control plane you deploy and operate in AWS.
Amazon Bedrock AgentCore is a set of managed AWS services for agents, including
Runtime and a managed Harness. Both can support isolated execution and durable
work; the decision is which control-plane and runtime responsibilities you want
AWS to manage.

## Compare the service boundary

| Concern | Rat Things | Bedrock AgentCore |
| --- | --- | --- |
| Application contract | Agents API-compatible Agents, Sessions, Turns and Items | AgentCore service APIs; Runtime and Harness have distinct roles |
| Agent loop | Codex or Pi Durable in your deployment | Bring an agent to Runtime or use the managed Harness |
| Execution | Dedicated EC2 or Lambda MicroVM workers | Runtime supports microVMs and an Instances compute type |
| Durability | Encrypted S3 content, DynamoDB coordination and runtime checkpoints | Configurable session filesystem storage and AgentCore Memory |
| Operations | You deploy and maintain the Rat Things stack | AWS operates the AgentCore service; you configure identity, storage and the agent |

See the [AgentCore overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/),
[session lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
and [Instances documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html).
AgentCore is not limited to ephemeral memory or a single compute model.

## Distinguish Runtime, Harness and Bedrock Managed Agents

AgentCore Runtime hosts agent code. The [AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
provides a managed agent loop. Separately,
[Bedrock Managed Agents powered by OpenAI](https://developers.openai.com/api/docs/guides/agents-api/bedrock-managed-agents)
adapts OpenAI's Agents API concepts to AWS. These names do not imply identical
endpoints, authentication or supported features.

Rat Things is useful when owning and modifying the API service, worker dispatch
and state coordination is a requirement. A managed service is a candidate when
you want AWS to operate more of that system. Using Bedrock for Rat Things model
inference does not make Rat Things an AgentCore deployment.

## Current boundaries

Rat Things is an engineering preview and requires operator maintenance. Matching
OpenAI resource types does not imply full hosted-service parity. AgentCore feature
availability depends on the selected service, compute type and AWS Region.
Compare the actual storage retention and recovery behavior required by your
workflow; neither an isolated VM nor persistent files imply exactly-once external
tool effects.

## Frequently asked questions

### Does AgentCore already support persistent Session files?

Yes. AWS documents configurable filesystem storage that survives compute
stop/resume. Evaluate its retention and lifecycle rules separately from structured
conversation memory and application-specific recovery records.

### Does Rat Things require AgentCore to run Codex?

No. Rat Things has its own execution adapters for EC2 and Lambda MicroVM workers.
It can use a deployment-configured model provider, including supported Bedrock
paths, independently of AgentCore Runtime.

## Sources

- [AgentCore services](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/)
- [AgentCore runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [AgentCore filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
- [Rat Things architecture](../docs/architecture.md)
