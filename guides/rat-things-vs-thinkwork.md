# Rat Things vs ThinkWork: two approaches to agents in your AWS account

Rat Things and ThinkWork both describe AWS-hosted agent systems with durable work
and controlled integrations. Rat Things centers its interface on Agents,
Sessions, Turns and Items, with Codex and Pi Durable runtimes. ThinkWork describes
a business agent harness organized around Agents, Spaces, Threads and Memory.
Compare the workflow and storage model, rather than treating self-hosting as a
feature unique to either project.

## Compare the documented architecture

| Concern | Rat Things | ThinkWork |
| --- | --- | --- |
| Work model | Agents, Sessions, Turns and Items | Agents, Spaces, Threads and Memory |
| Runtime focus | Codex or Pi Durable behind an Agents API-compatible service | Business agent harness with its own agent loop |
| AWS deployment | Terraform module with EC2 or Lambda MicroVM workers | Terraform deployment in a VPC |
| Saved state | Encrypted S3 content and DynamoDB coordination | Aurora-backed agent state |
| Model access | Operator-configured Codex paths; Pi Durable uses Bedrock in AWS | Bedrock endpoint in the documented AWS deployment |

ThinkWork's [project documentation](https://docs.thinkwork.ai/) describes its
objects, Terraform deployment, Cognito identity and Aurora/Bedrock architecture.
Rat Things' [operating model](../docs/operating-model.md) and
[architecture](../docs/architecture.md) describe the corresponding local contracts.

## Choose around the work your users do

ThinkWork is a candidate to evaluate when a business workspace organized around
Spaces, Threads and shared context fits your product. Rat Things is a candidate
when your application needs Codex or Pi Durable Sessions, an official OpenAI SDK
client shape and operator-owned execution coordination.

For a scheduled review that uses Slack and creates a Linear issue, inspect the
identity mapping, allowed operations, saved input and delivery outcome in either
system. Rat Things separates [ingress, execution and delivery](slack-to-linear-agent-workflow.md)
and resolves authority before launch. A conversation log alone is not evidence
that an external operation can be repeated safely.

## Current boundaries

Rat Things is an engineering preview. This comparison uses ThinkWork's published
architecture, not an installation or independent reliability assessment. It does
not establish SDK compatibility, migration support or feature parity between the
projects. Choose from the contracts your workflow actually requires and verify
them against the version you deploy.

## Frequently asked questions

### Is self-hosting in AWS unique to Rat Things?

No. ThinkWork also documents deployment in your AWS account. Compare who operates
each service, the agent runtime, the saved-work model and the integration
permissions instead of relying on the self-hosted label alone.

### Can ThinkWork Threads be imported as Rat Things Sessions?

Rat Things does not document an automatic ThinkWork migration. A migration would
need explicit mappings for identities, conversation history, files, tools and
pending work; similarly named concepts do not establish interoperability.

## Sources

- [ThinkWork project documentation](https://docs.thinkwork.ai/)
- [Rat Things operating model](../docs/operating-model.md)
- [Rat Things architecture](../docs/architecture.md)
- [Rat Things capability envelope](../docs/capability-envelope.md)
