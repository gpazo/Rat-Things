# How to keep Codex running after you close your laptop

To keep a Codex task running after your laptop disconnects, move execution to remote compute and
store the request, conversation, workspace, and result outside that compute. A terminal multiplexer
can survive a closed terminal, but it cannot survive a sleeping laptop or lost machine. Rat Things
is one self-hosted AWS implementation: submit a durable handoff, run Codex in an isolated Lambda
MicroVM, and return to the same conversation later.

> **Short answer:** remote compute solves process lifetime; durable state solves machine lifetime.
> You need both if the work must survive suspension, replacement, or a local network disconnect.

## Why a local Codex task stops

A normal local task depends on several things that disappear together:

- the Codex process and its parent terminal;
- a powered, connected computer;
- the current checkout and uncommitted workspace files;
- cached agent-thread state; and
- a place to deliver the eventual result.

Keeping a shell open addresses only the first dependency. Preventing sleep addresses the first two,
but leaves the task tied to one physical machine. A durable cloud handoff separates the work record
from the worker that happens to execute it.

## Choose the smallest approach that fits

| Approach | Survives a closed terminal | Survives laptop sleep | Survives worker replacement | Operating burden |
| --- | --- | --- | --- | --- |
| `tmux` or `screen` | Yes | No | No | Low |
| Remote development VM | Yes | Yes | Usually no, unless state is externalized | Medium |
| [Codex cloud](https://learn.chatgpt.com/docs/cloud) or another managed cloud agent | Yes | Yes | Service-dependent | Low |
| Self-hosted durable backend | Yes | Yes | Yes, when state lives outside compute | High |

Use `tmux` for a long command on a machine that will remain awake. Use a remote VM when one stable
server and checkout are enough. Choose a managed service when convenience matters more than owning
the runtime and credential boundary. Choose a self-hosted backend when the AWS account, identity
model, integrations, and retained work must remain under your control.

## What a durable handoff needs

A reliable handoff has five separate responsibilities:

1. **Commit the request before starting work.** The client needs a receipt it can retain even if it
   disconnects immediately afterward.
2. **Launch isolated compute.** One task should not inherit another task's workspace or authority.
3. **Store progress and results outside the worker.** Queue delivery alone is not a durable source
   of truth.
4. **Restore conversation and workspace state.** A replacement worker needs more than a transcript
   if the agent modified files or maintains native thread state.
5. **Deliver or expose the result later.** Completion cannot depend on the submitting terminal
   still listening.

Rat Things represents every accepted handoff as one durable Run. Conversation metadata and bounded
coordination live in DynamoDB; complete message bodies, events, results, attachments, and generated
files live in encrypted S3. With S3 Files enabled, replacement compute can also restore the native
Codex state and exact workspace bytes. Read the detailed [conversation durability
model](../docs/conversations.md#how-durability-works).

## Hand a task off from the command line

After deploying Rat Things, submit work without waiting for completion:

```bash
npm run rat-things -- handoff \
  --thread release-readiness \
  --no-wait \
  "Draft a release-readiness checklist with rollback steps and return it in your response."
```

This example needs no repository checkout. The command returns the durable Run receipt. Closing the terminal after the
request has been accepted does not terminate the cloud worker. Later, inspect or continue the same
work:

```bash
npm run rat-things -- conversation show release-readiness
npm run rat-things -- chat --thread release-readiness \
  "Refine the checklist into a concise go/no-go review."
```

Use an idempotency key when an automated caller may retry the same semantic request. Reusing the
same key with the same canonical request returns the existing Run instead of creating duplicate
work.

## Decide authority before the handoff

Unattended execution removes the opportunity to approve each command interactively. Rat Things
therefore resolves a fixed capability envelope before a Run starts. Shell access, network access,
browser use, connected accounts, IAM, provider scopes, account grants, and operation constraints
can all narrow what the agent receives. A denied capability does not become a pending approval.

Start a new workflow read-only and without network access. Add workspace writes, selected network
destinations, or exact integration operations only when the task requires them. The complete rule
is documented in [the capability envelope](../docs/capability-envelope.md).

## Evidence and limitations

| Evidence field | What is established |
| --- | --- |
| Date | September 1, 2026 |
| Source revision | Working tree based on `818591feeaea5b351364e68808a2566ca55bb025`; not a clean release artifact |
| Environment | `us-west-2`; ARM64 Lambda MicroVM; Codex with the ChatGPT file bridge |
| Model/provider | Codex using OpenAI models through the copied ChatGPT account session; the retained public record does not name a model ID |
| Scenario | A draft test and a second invocation of its published immutable revision |
| Result | Both Runs succeeded; setup through the second Run took 521 seconds; teardown left zero active MicroVMs and removed the managed credential |
| Reproduce | Follow the [AWS quickstart](../docs/quickstart.md), retain the returned Run receipt, then inspect the same thread from a second CLI process |
| Evidence | [Dated authentication canary record](../docs/codex-subscription.md#live-verification-status) |
| Limits | The published canary proves remote execution after an accepted handoff. It did **not** deliberately close or sleep the submitting laptop, so client-disconnect survival remains an unrecorded acceptance test. It also does not prove high concurrency, disaster recovery, or untrusted multi-tenant isolation. |

A direct acceptance test should submit with `--no-wait`, save the receipt, terminate the local CLI,
and retrieve the terminal Run and conversation from another process or device. Until that recorded
test exists, this page distinguishes the architectural guarantee from the exact scenario already
captured.

## When Rat Things is not the right answer

Do not operate this stack merely to keep one occasional command alive. A remote VM or managed cloud
task is simpler. Rat Things is an engineering preview intended for trusted, owner-operated agents;
it is not ready to host mutually untrusted customers. It becomes useful when several requirements
arrive together: AWS ownership, durable conversations, isolated execution, schedules, connected
accounts, retained files, and one API shared by multiple entry points.

## Sources

- [Codex cloud: background and parallel cloud tasks](https://learn.chatgpt.com/docs/cloud)
- [Rat Things conversation durability](../docs/conversations.md#how-durability-works)
- [Rat Things capability envelope](../docs/capability-envelope.md)
- [Rat Things authentication canary](../docs/codex-subscription.md#live-verification-status)

## Try the narrow path

Run the [AWS-ready quickstart](../docs/quickstart.md) in a disposable AWS sandbox. It performs
readiness checks before AWS writes, creates a deliberately narrow deployment, proves an exact Thing
revision with two Runs, and provides a self-verifying teardown path.
