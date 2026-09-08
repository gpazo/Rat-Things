# Capabilities and boundaries

Rat Things accepts work into a durable control plane and runs agents in disposable AWS Lambda
MicroVMs. Start with the [operating model](operating-model.md) for the core objects and the
[architecture](architecture.md) for their implementation.

## Current maturity

Rat Things is an engineering preview for owner-operated deployments. Its isolation and recovery
mechanisms do not make it a production-ready, untrusted multi-tenant service. Choose deployment
identity, retention, network policy, and operational limits for the environment that will use it.

| System | What it provides | Learn more |
| --- | --- | --- |
| Runs | Owner-scoped acceptance, idempotency, state transitions, cancellation, and retained results | [API](api.md) |
| Things | Immutable revisions, draft testing, active publication, manual invocation, and schedules | [Things](things.md) |
| Connections | Provider-verified accounts, host-owned credentials, grants, and account-specific operations | [Integrations](plugins.md) |
| Capability envelope | A fixed intersection of provider, deployment, profile, account, and Run permissions | [Permissions](capability-envelope.md) |
| Conversations | Ordered mailboxes, fenced workers, replay, and shared console/CLI history | [Conversation durability](conversations.md#how-durability-works) |
| Execution | One-shot MicroVMs or suspend/resume; optional S3 Files restores native agent state and workspace in replacement compute | [Execution lifecycle](architecture.md#lifecycle) |
| Files and publications | Private retained bytes, owner-scoped catalogs, and expiring file/site/video share grants | [Files](durable-files.md), [publishing](publications.md) |
| Browser | Public-web navigation, screenshots, recordings, live viewing, exclusive takeover, and demonstration-to-draft conversion | [Browser use](browser-computer-use.md) |
| Channels | Signed GitHub, GitLab, Teams, and optional Slack ingress with separate result delivery | [Channels](channels.md) |
| Authentication | A deliberate file-based ChatGPT credential bridge or short-lived Bedrock model authentication | [Credential lifecycle](codex-subscription.md#credential-risk-and-lifecycle) |
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
   of the existing durable mailbox.

Enterprise administration and a separate always-on execution tier remain outside the current
product scope. Lambda MicroVMs are the only remote execution backend.

## Reference provenance

The [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
informed lifecycle/image behavior. [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274)
informed the composition-root, provider-plugin, ingress, identity/credential, execution, delivery,
and durable-mailbox boundaries. Neither codebase is vendored; attribution is in
[`NOTICE`](../NOTICE).
