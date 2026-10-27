# Rat Things vs OpenAgentCore: self-hosted Agents API implementations

Rat Things and OpenAgentCore both offer self-hosted control planes using OpenAI
Agents API concepts and the official SDK. They differ in integrated runtimes,
deployment choices and the contracts around execution and recovery. Compatibility
should be checked operation by operation for the installed versions.

## Compare the documented design

| Concern | Rat Things | OpenAgentCore |
| --- | --- | --- |
| Client model | Agents API-compatible service with documented extensions and limits | Agents API service through the official OpenAI SDK |
| Harnesses | Codex and Pi Durable | Codex, Claude Code and MiniMax Code |
| Deployment focus | Local workspace and Terraform-managed AWS stack | Self-hosted Core, runtime and sandbox-provider components |
| Cloud state | Encrypted S3 content and DynamoDB coordination in your AWS account | Core owns Session state and coordinates its runtime and sandbox provider |
| Configuration | Session runtime pinned through `rat_things_runtime` metadata | Harness and model-provider extensions documented by OpenAgentCore |

OpenAgentCore's [project overview](https://openagentcore.dev/) describes its
components, harness choices and client examples. Rat Things documents its
[runtime selector and API contract](../docs/agents-api.md) separately.

## Choose the runtime and operating model you need

OpenAgentCore is a candidate when its harness choices and replaceable components
fit your application. Rat Things is a candidate when you want Codex or Pi Durable
with AWS-specific storage, IAM authentication, Terraform deployment and Session
worker coordination already integrated.

If you already use the OpenAI SDK, compare the calls and lifecycle events your
application relies on: Session creation, streaming, cancellation, function
results, credentials, files and worker replacement. A shared client shape does
not establish identical behavior. The same applies to moving conversation state
between two independently implemented servers.

## Current boundaries

Rat Things is an engineering preview. This comparison does not establish complete
parity with OpenAI or OpenAgentCore, and Rat Things does not document automatic
Session migration from either service. It integrates Codex and Pi Durable;
other native harnesses are not interchangeable runtime settings. Review
[current runtime limits](../docs/agent-runtimes.md) before selecting a backend.

## Frequently asked questions

### Is Rat Things the only self-hosted Agents API-compatible server?

No. OpenAgentCore also describes a self-hosted implementation using the official
OpenAI SDK. Compare supported operations, harnesses, storage and deployment
responsibilities rather than assuming exclusivity.

### Does the official OpenAI SDK guarantee identical behavior across servers?

No. SDK types and resource names are one part of compatibility. Authentication,
extensions, tool support, streaming and recovery behavior must match the server
and runtime you deploy.

## Sources

- [OpenAgentCore overview](https://openagentcore.dev/)
- [OpenAgentCore repository](https://github.com/MiniMax-AI/OpenAgentCore)
- [Rat Things API contract](../docs/agents-api.md)
- [Rat Things runtime comparison](../docs/agent-runtimes.md)
