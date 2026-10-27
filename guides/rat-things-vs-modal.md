# Rat Things vs Modal: self-hosted agent control plane or managed compute?

Rat Things provides a self-hosted AWS control plane for Codex and Pi Durable.
Modal Sandboxes provide managed containers for executing untrusted code. They
address different layers: a durable agent service and compute that an agent
application can use.

## Compare what the application receives

| Concern | Rat Things | Modal Sandboxes |
| --- | --- | --- |
| Main resource | Durable Agent and Session | Sandbox created through Modal's SDK |
| Agent loop | Integrated Codex or Pi Durable | Your application chooses and runs the agent |
| Execution | Per-session EC2 or Lambda MicroVM workers in your AWS account | Containers on Modal's platform |
| Saved work | Session journal, native runtime state and configured workspace recovery | Snapshot facilities for sandbox state; application history remains an application design concern |
| Operations | You maintain the AWS deployment, images and access policy | Modal manages the sandbox infrastructure; you maintain the application |

Modal's [sandbox guide](https://modal.com/docs/guide/sandboxes) describes command
execution and lifecycle operations. Its [snapshot documentation](https://modal.com/docs/guide/sandbox-snapshots)
describes state preservation. Those capabilities should be assessed alongside the
application's conversation and tool-effect records.

## Choose which service boundary you want

Modal is a candidate when managed execution beneath your own application is the
goal. Rat Things is a candidate when you want a deployable Session API, isolated
workers, encrypted saved history and explicit authority boundaries in AWS.

For an agent that edits code and creates an external issue, separately identify
the owner of workspace files, pending tool calls and the issue-creation receipt.
Restoring compute state does not itself prove that repeating an external write
is safe. Rat Things' [durable state guide](durable-ai-agent-state.md) explains how
its runtime and storage contracts handle that distinction.

## Current boundaries

Rat Things is an engineering preview, not an implementation of Modal's API or a
replacement for every Modal compute workload. It supports its documented Linux
worker backends and runtime capabilities. This comparison concerns Modal's
documented managed sandbox service; it makes no claim about separately negotiated
deployment offerings or comparative performance.

## Frequently asked questions

### Is Rat Things a self-hosted Modal server?

No. It is a self-hosted agent control plane with its own AWS worker adapters and
an Agents API-compatible interface. Modal applications need an explicit design
change to use Rat Things Sessions.

### Is a sandbox snapshot enough to recover an agent workflow?

Not by itself. Recovery also needs accepted input, conversation and tool results,
execution ownership, and a policy for external operations whose outcome is
uncertain. Evaluate those records alongside the saved workspace.

## Sources

- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)
- [Modal sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots)
- [Rat Things architecture](../docs/architecture.md)
- [Rat Things runtime boundaries](../docs/agent-runtimes.md)
