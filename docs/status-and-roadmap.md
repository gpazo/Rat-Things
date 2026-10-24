# Capabilities and boundaries

Rat Things keeps durable conversations on your computer and runs managed agents in
isolated AWS workers using dedicated EC2 instances or Lambda MicroVMs. Start with
the [local workspace guide](local-workspace.md) to try it, the [operating model](operating-model.md) for the core objects and the
[architecture](architecture.md) for their implementation.

## Current maturity

Rat Things is an engineering preview for owner-operated deployments. Its isolation and recovery
mechanisms do not make it a production-ready, untrusted multi-tenant service. Choose deployment
identity, retention, network policy, and operational limits for the environment that will use it.

| System | What it provides | Learn more |
| --- | --- | --- |
| Agent runtimes | Codex and Pi Durable behind the same API, CLI, desktop, schedules, and provider bindings | [Runtime comparison](agent-runtimes.md) |
| Local workspace | Private loopback API, durable local Agents and Sessions, Codex and Pi Durable with ChatGPT subscriptions, local Linux workers on Apple silicon Macs, resumable Session copying into AWS | [Start at home](local-workspace.md) |
| Sessions and Turns | Owner-scoped input, ordered execution, cancellation and saved Items | [Agents API](agents-api.md) |
| Agents and schedules | Reusable standard Agent configurations and AWS schedule inputs | [Agents](agents-api.md), [schedules](schedules.md) |
| Connections | Provider-verified accounts, host-owned credentials, grants, and account-specific operations | [Integrations](plugins.md) |
| Capability envelope | A fixed intersection of provider, deployment, profile, account, and Session permissions | [Permissions](capability-envelope.md) |
| Session forks | Independent managed workspaces and inherited conversation context, with lineage and fresh credentials; opt-in checkpoints required | [Fork semantics](agents-api.md#fork-a-session), [demo](session-fork-demo.md) |
| Session history | Durable outbox, runtime journal and saved Items in the console and SDK | [Session durability](conversations.md#how-durability-works) |
| Execution | Private EC2 or MicroVM harness; saved Session history survives worker loss | [Agents execution](agents-api.md) |
| Files and publications | Private retained bytes, immutable Session artifacts, and expiring file/site/video share grants | [Files](durable-files.md), [publishing](publications.md) |
| Browser | Declared function/MCP integration and an optional Playwright MCP configuration | [Browser use](browser-computer-use.md) |
| Channels | Authenticated GitHub, GitLab, Teams, and optional Slack ingress with separate result delivery | [Channels](channels.md) |
| API authentication | AWS IAM issuance and owner-bound, scoped bearer tokens | [API permissions](agents-api.md#scoped-api-keys) |
| Model authentication | Codex uses the configured ChatGPT bridge or Bedrock; Pi Durable uses local ChatGPT subscriptions or approved Bedrock Converse models on AWS | [Runtime setup](agent-runtimes.md#start-with-the-appropriate-setup) |
| Recovery | Queue repair, generation-fenced liveness, cancellation settlement, and per-destination delivery fences | [Runbook](runbook.md) |

## Known gaps

- **Local execution:** Linux workers currently require an Apple silicon Mac and a
  supported VM-backed container engine. Local Vaults, uploaded Files, plugins,
  MCP, schedules and webhooks remain unavailable. Session copying moves idle application
  state into an existing AWS deployment; it does not migrate running processes or
  subscription credentials. Codex/ChatGPT is the first local subscription provider.

- **Multi-tenant operation:** destination authorization, output redaction, per-owner budgets and
  rate limits, and independent security review remain incomplete. The control API's ownership
  checks do not replace these controls. See the [security model](security.md).
- **Credential isolation:** the ChatGPT file bridge exposes reusable account credentials to code
  running as the agent UID. Use it only with trusted agents and accounts. Generic source bindings
  also require a trusted operator; arbitrary provider selectors are not provider-verified.
- **Channels:** Teams uses an outgoing-webhook/Workflow or reply-gateway bridge. A native
  Entra/Bot/Teams gateway remains future work. Linear provides account tools but cannot start
  conversations through native mentions, delegation, or Agent Session events.
- **Browser scope:** an ordinary Session has no browser provider. The optional provider must be
  installed in its execution environment. The console has no live browser viewer or takeover;
  authenticated browser-profile restoration is not a supported continuity guarantee.
- **Runtime differences:** Pi supports function tools, MCP, and durable subagents. Hosted skills
  and plugins, self-hosted environments, JSON-schema output, and built-in web search are unsupported.
  Model and reasoning settings must match the approved Pi catalog.
- **Memory and collaboration:** Codex journals and Pi's committed task state support recovery.
  Pi's child conversations and pending function calls retain their identities across replacement. Rat Things-specific
  semantic memory, fallback summaries, explicit agent handoffs, and shared-conversation membership
  are not implemented. Storage retention is finite and is separate from a backup policy.
- **Capacity:** startup latency, quotas, concurrency, and cost depend on the deployment. There are
  no sustained-load or cross-Region recovery guarantees. See [cost drivers](costs.md) and
  [startup diagnosis](runbook.md#slow-conversation-startup-or-codex-initialization).
- **Extensibility:** provider adapters are trusted code. There is no public plugin marketplace,
  arbitrary runtime plugin loader, or general visual workflow builder.

## Roadmap

Local-first development comes next: an isolated local computer backend behind the
existing environment ports; readiness and capacity reporting; resumable setup; and
an explicit, verifiable transfer of Session context and files into AWS. Keep one
API and one desktop workflow across these backends. Local operation should remain
a complete choice for people whose hardware is sufficient.

The cloud system improvements center on four areas:

1. Add usage budgets, per-owner limits, destination authorization, and output controls around the
   existing fixed capability envelope.
2. Extend host-owned provider integrations and define a contributor SDK before expanding the
   connector catalog.
3. Improve browser credential isolation, interaction coverage, and recording finalization without
   exposing a general remote desktop.
4. Define shared-conversation authorization, semantic memory, and explicit handoff contracts on top
   of the durable Session history and outbox.

Enterprise administration remains outside the current product scope. Dedicated EC2
workers support persistent harnesses; Lambda MicroVM workers have a bounded lifetime.

## Reference provenance

The [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
informed lifecycle/image behavior. [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
informed the composition-root, provider-plugin, ingress, identity/credential, execution, delivery,
and durable-mailbox boundaries. Neither codebase is vendored; attribution is in
[`NOTICE`](../NOTICE).
