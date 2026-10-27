# Rat Things vs E2B: agent control plane or sandbox infrastructure?

Rat Things supplies an AWS control plane for Codex and Pi Durable, with durable
Sessions, isolated workers and an Agents API-compatible interface. E2B supplies
sandbox infrastructure that can run many agent stacks. Choose based on whether
you need an integrated Session service or compute beneath an application you own.

## Compare the responsibility boundary

| Question | Rat Things | E2B |
| --- | --- | --- |
| Main abstraction | Agent, Session, Turn and Item | Programmable sandbox |
| Agent runtime | Integrated Codex or Pi Durable | Bring an agent stack or use a template |
| Deployment | Local workspace or operator-owned AWS deployment | E2B Cloud, managed BYOC, or E2B Embed |
| AWS ownership | API, harness, workers and saved state in your account | BYOC places the data plane in your cloud; assess control-plane custody separately |
| Durable application state | S3 content, DynamoDB coordination and runtime recovery contracts | Your application must define how sandbox state relates to its conversation and work records |

E2B documents these deployment options on its [enterprise page](https://e2b.dev/enterprise)
and describes a self-hostable runtime and agent templates on its
[product page](https://e2b.dev/). E2B is not limited to a vendor-hosted sandbox.

## Choose for the application you are building

E2B is a candidate when you already own the agent loop and want a sandbox API
beneath it. Rat Things is a candidate when you want saved Agents and Sessions,
IAM-backed access, fixed tool authority and worker coordination assembled in AWS.
This is an architectural fit assessment, not a performance ranking.

For a repository task, identify who accepts the input, records tool results,
decides whether recovery is safe and delivers the outcome. A sandbox snapshot
alone does not answer those application-level questions. Rat Things documents
its [recovery rules](durable-ai-agent-state.md), including cases where live process
state is lost or an uncertain external write needs reconciliation.

## Current boundaries

Rat Things is an engineering preview and adds deployment and upgrade work for
your team. It does not implement the E2B SDK or automatically convert existing
sandboxes into Sessions. E2B deployment modes have different ownership boundaries;
verify the mode you intend to use. This comparison makes no latency or reliability
benchmark claim.

## Frequently asked questions

### Is Rat Things a drop-in E2B replacement?

No. Rat Things exposes an Agents API-compatible Session service. E2B exposes
sandbox operations. Moving an application requires mapping its orchestration,
files, authentication and recovery behavior to the new service.

### Is running compute in my AWS account the same as self-hosting the control plane?

No. Ask who operates the API, stores conversation state and owns the agent loop.
Compute placement is one boundary; control-plane ownership is another.

## Sources

- [E2B deployment options](https://e2b.dev/enterprise)
- [E2B runtime and agent stacks](https://e2b.dev/)
- [Rat Things architecture](../docs/architecture.md)
- [Rat Things API contract](../docs/agents-api.md)
