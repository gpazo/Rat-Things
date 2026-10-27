# Rat Things vs Daytona: durable Sessions and programmable sandboxes

Rat Things combines a Codex or Pi Durable harness, durable Session records and
isolated AWS execution. Daytona provides programmable sandboxes for agent
applications. The key decision is how much of the agent's orchestration and saved
work you want your application to own.

## Compare the application boundary

| Concern | Rat Things | Daytona |
| --- | --- | --- |
| Public interface | Agents API-compatible resources and Rat Things extensions | Sandbox SDKs and APIs |
| Agent loop | Codex or Pi Durable integrated into the Session lifecycle | Your chosen agent application uses the sandbox |
| Work environment | Local Linux workspace or dedicated AWS EC2/Lambda MicroVM workers | Sandbox operations for commands, files, Git and processes |
| Compute in your account | Operator-deployed AWS control plane and workers | BYOC attaches your runner infrastructure to Daytona's control plane |
| Recovery design | Saved input receipts, runtime checkpoints and fenced worker ownership | Application orchestration must connect sandbox persistence to its work records |

Daytona describes its [sandbox capabilities](https://www.daytona.io/docs/en/sandboxes/)
and its [BYOC control-plane boundary](https://www.daytona.io/docs/en/bring-your-own-compute/).
Its documentation distinguishes the latest release from a separate v2 alpha;
use documentation matching your chosen version.

## Choose around your existing system

Daytona is a candidate when your application already manages prompts, models,
conversation history and task state, and needs a programmable workspace. Rat
Things is a candidate when you want those agent resource and worker coordination
contracts in a deployment you operate in AWS.

For a multi-turn coding task, compare the preserved files with the preserved
conversation and pending tool calls. Then decide who handles a failed worker and
an external operation with an unknown outcome. Rat Things' [durability guide](durable-ai-agent-state.md)
describes those distinctions without promising to restore arbitrary processes.

## Current boundaries

Rat Things is an engineering preview. It does not implement Daytona's SDK or
provide automatic sandbox migration. Daytona's documented BYOC path requires
organization enablement and retains its control plane; that path should not be
described as self-hosting every service. The comparison covers that documented
path and does not rule out other deployment arrangements.

## Frequently asked questions

### Does Daytona BYOC move the agent control plane into my account?

The documented BYOC path runs sandbox workloads on your infrastructure while
Daytona's control plane manages them. Review that boundary independently from
where your own application runs its agent loop and stores history.

### Can I use the same SDK calls for Daytona and Rat Things?

No. Their APIs model different resources. Rat Things uses Agents, Sessions, Turns
and Items; an integration using Daytona sandbox operations needs an explicit
adaptation rather than a base-URL change.

## Sources

- [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes/)
- [Daytona Bring Your Own Compute](https://www.daytona.io/docs/en/bring-your-own-compute/)
- [Rat Things architecture](../docs/architecture.md)
- [Rat Things API contract](../docs/agents-api.md)
