# Capabilities and boundaries

Rat Things accepts work into a durable control plane and runs agents in isolated AWS workers
using dedicated EC2 instances or Lambda MicroVMs. Start with the [operating model](operating-model.md) for the core objects and the
[architecture](architecture.md) for their implementation.

## Current maturity

Rat Things is an engineering preview for owner-operated deployments. Its isolation and recovery
mechanisms do not make it a production-ready, untrusted multi-tenant service. Choose deployment
identity, retention, network policy, and operational limits for the environment that will use it.

| System | What it provides | Learn more |
| --- | --- | --- |
| Sessions and Turns | Owner-scoped input, ordered execution, cancellation and saved Items | [Agents API](agents-api.md) |
| Agents and schedules | Reusable standard Agent configurations and AWS schedule inputs | [Agents](agents-api.md), [schedules](schedules.md) |
| Connections | Provider-verified accounts, host-owned credentials, grants, and account-specific operations | [Integrations](plugins.md) |
| Capability envelope | A fixed intersection of provider, deployment, profile, account, and Session permissions | [Permissions](capability-envelope.md) |
| Session history | Durable outbox, runtime journal and saved Items in the console and SDK | [Session durability](conversations.md#how-durability-works) |
| Execution | Private EC2 or MicroVM harness; saved Session history survives worker loss | [Agents execution](agents-api.md) |
| Files and publications | Private retained bytes, immutable Session artifacts, and expiring file/site/video share grants | [Files](durable-files.md), [publishing](publications.md) |
| Browser | Declared function/MCP integration; isolated private helper for local execution | [Browser use](browser-computer-use.md) |
| Channels | Signed GitHub, GitLab, Teams, and optional Slack ingress with separate result delivery | [Channels](channels.md) |
| API authentication | AWS IAM issuance and owner-bound, scoped bearer tokens | [API permissions](agents-api.md#scoped-api-keys) |
| Model authentication | Operator-configured ChatGPT credential bridge or Bedrock access | [Credential lifecycle](codex-subscription.md#credential-risk-and-lifecycle) |
| Recovery | Queue repair, generation-fenced liveness, cancellation settlement, and per-destination delivery fences | [Runbook](runbook.md) |

## Known gaps

- **Multi-tenant operation:** destination authorization, output redaction, per-owner budgets and
  rate limits, and independent security review remain incomplete. The control API's ownership
  checks do not replace these controls. See the [security model](security.md).
- **Credential isolation:** the ChatGPT file bridge exposes reusable account credentials to code
  running as the agent UID. Use it only with trusted agents and accounts. Generic source bindings
  also require a trusted operator; arbitrary provider selectors are not provider-verified.
- **Channels:** Teams uses an outgoing-webhook/Workflow or reply-gateway bridge. A native
  Entra/Bot/Teams gateway remains future work. Linear provides account tools but cannot start
  conversations through native mentions, delegation, or Agent Session events.
- **Browser scope:** secure credential entry, file transfer, multiple tabs/windows, richer pointer
  interactions, and general desktop control are absent. Authenticated browser-profile restoration
  is not a supported continuity guarantee. Video encoding can delay finalization.
- **Memory and collaboration:** native Codex state and bounded replay are durable. Rat-specific
  semantic memory, fallback summaries, explicit agent handoffs, and shared-conversation membership
  are not implemented. Storage retention is finite and is separate from a backup policy.
- **Capacity:** startup latency, quotas, concurrency, and cost depend on the deployment. There are
  no sustained-load or cross-Region recovery guarantees. See [cost drivers](costs.md) and
  [startup diagnosis](runbook.md#slow-conversation-startup-or-codex-initialization).
- **Extensibility:** provider adapters are trusted code. There is no public plugin marketplace,
  arbitrary runtime plugin loader, or general visual workflow builder.

## Roadmap

The next system improvements center on four areas:

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
