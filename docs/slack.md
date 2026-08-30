# Use Rat Things from Slack

Slack can be a user-facing entrance to Rat Things, an agent tool, and a result destination. A signed
`@mention` starts durable work in an isolated AWS MicroVM, a reply in the same Slack thread
continues the Rat conversation, and the completed answer returns to that thread. The agent can also
search, post, reply, or react through an installed Slack Connection when its fixed capability
envelope admits those operations.

This page describes what users and agents can do now. For installation details, signature handling,
and the current acknowledge-before-processing limitation, use [Channels and provider
adapters](channels.md#slack-self-hosted-channel-adapter). For account grants and OAuth internals,
use [Integrations, accounts, and permissions](plugins.md).

## What users can do today

| Experience | Current behavior | Authority boundary |
| --- | --- | --- |
| Start work | Mention Rat Things in a channel subscribed to `app_mention` | Slack v0 signature, timestamp, workspace binding, and sender identity are verified before submission |
| Continue work | Mention Rat Things again in the same Slack thread | The thread selects the same durable Rat conversation; it cannot change that conversation's fixed execution or integration policy |
| Receive an answer | Successful, failed, or cancelled work is delivered through `chat.postMessage` | Trusted delivery uses the bound service Connection and preserves the source thread |
| Search messages | The agent calls `slack.messages.search` | Search uses the separately authorized installing-user token and sees only that user's Slack visibility |
| Post or reply | The agent calls `slack.messages.post`, optionally with a parent timestamp | The bot token, provider scopes, Rat grant, profile, per-Run allow/deny lists, and resource constraints must all admit the call |
| Add a reaction | The agent calls `slack.reactions.add` | The same fixed permission intersection applies before the credential is read |
| Deliver scheduled work | A Thing or Routine sends its result to a Slack channel | Scheduling does not bypass the selected Connection, grant, profile, destination, or ordinary Run lifecycle |
| Use broader Rat tools | A mention can use web, browser, files, skills, apps, MCP, or other Connections when its source binding/profile admits them | Slack is the request and delivery surface; the admitted tools still execute inside the MicroVM envelope |

Every accepted request still has one Run ID, durable state, encrypted inputs/results, and the same
desktop, CLI, and API projections as non-Slack work. Slack receives the conversational answer. Use
Rat's desktop, CLI, or API for deeper activity, generated files, browser takeover, steering,
interrupts, and account administration.

## Useful Slack workflows

### Research and summarize workspace context

Ask Rat to find decisions, customer context, handoff notes, or earlier discussions and turn the
matches into a concise brief. Search authority belongs to the installing Slack user, not the bot and
not a workspace administrator.

Example:

> @Rat Things Find the final renewal decision and summarize the unresolved security questions. Link
> the matching messages. Do not post or react.

Use a read-only profile and admit only `slack.messages.search` when the task does not need a write.

### Continue an investigation in one thread

Start with a broad question, then refine the output without repeating the earlier prompt or search
results. Rat maps the Slack source thread to one durable conversation. When possible, the next turn
resumes the same suspended MicroVM and native Codex thread. When replacement compute is required,
the transcript remains durable and S3 Files can restore the native Codex state and workspace.

### Research, then follow through

A read/write agent can search for the approved content, post a concise update to an allowed
channel, reply under a known parent message, or add a reaction. Narrow the Run to the exact
operations it needs:

```bash
rat-things chat --thread customer-renewal \
  --connection slack-work=read-write \
  --allow-operation slack-work=slack.messages.search,slack.messages.post,slack.reactions.add \
  "Find the approved renewal summary, post it in C01234567, and add a check mark to the source"
```

If the persistent grant constrains `channel`, the agent cannot redirect the post to another
channel. A prompt cannot install a Connection, reconnect OAuth, change a grant, or widen the active
Run.

### Send recurring briefings

Put repeatable research or monitoring in a Thing or interval Routine and select a Slack
destination. Useful examples include a morning customer-operations summary, a weekly decision
digest, release readiness notes, and an exception alert. Prefer a revisioned Thing for new work so
the draft can be explained, tested, and published before its schedule becomes active.

### Launch work beyond Slack

Slack does not limit the task to Slack APIs. A source binding can select a profile and Connection
Set that admits browser research, web search, repository work, file generation, or other trusted
integrations. The agent performs that work inside its MicroVM and returns the result to the source
thread. Generated files remain in Rat's durable file plane; the current Slack adapter does not
upload those files into Slack.

## Install and bind a workspace

The self-hosted operator supplies the Slack OAuth application and signing secret through AWS, then
the user installs the account through the desktop Connections page or CLI:

```bash
rat-things connect slack --oauth --wait --access read-write --alias slack-work
rat-things connection test slack-work
rat-things slack-events slack-work --profile read-only --json
```

`slack-events` derives the Slack workspace selector from the verified Connection. It creates the
owner-scoped Connection Set and source binding, leaves trusted source-thread delivery write-capable,
and gives the agent the requested profile (`read-only` by default). A second Connection cannot
silently take over mention routing for the same workspace.

The Slack OAuth application currently requests bot scopes `app_mentions:read`, `chat:write`, and
`reactions:write`, plus delegated user scope `search:read`. The bot and user token families refresh
independently. Neither token is placed in the prompt, tool arguments, Run record, Terraform state,
or agent filesystem.

## Current Slack boundaries

Rat's built-in Slack surface is intentionally narrow:

- inbound work requires `app_mention`; direct messages, slash commands, message shortcuts,
  reaction triggers, and arbitrary channel messages are not accepted;
- agent tools are API reachability, message search, message post/thread reply, and reaction add;
  message edit/delete, channel administration, canvases, and file operations are not installed;
- Slack receives final text, not live activity, browser takeover, structured-input forms, or file
  uploads;
- account installation, health, reconnect, grants, consumers, and revocation live in the trusted
  desktop/CLI/API control plane rather than Slack buttons;
- the self-hosted app is not an App Directory marketplace listing; and
- the current ingress durably submits before acknowledging Slack. Move to an acknowledge-first
  queue/worker split and validate cold starts before production-sensitive use.

Treat Slack text and linked content as untrusted input. The `@mention` is a noise and cost gate, not
authorization for broader tools or data. A source binding and fixed capability envelope decide what
the Run can use before Codex starts.

## Extend from Slack to another service

Slack uses the same trusted [Integration Contract v1](plugins.md#the-integration-contract-v1) as
other connected accounts. To add another service, define its authentication scheme, provider
identity verification, operations, input schemas, access/risk labels, provider scopes, and fixed
HTTP adapter. Register it in the trusted host image and reuse the existing:

- OAuth or credential installation and reconnection flow;
- owner-scoped Connections and Secrets Manager vault;
- health, grant, resource-constraint, and “used by” views;
- permission intersection and credential broker;
- dynamic agent-tool generation and durable tool-call ledger; and
- Thing, Routine, desktop, CLI, API, and agent-to-agent Run surfaces.

Extensions are reviewed host code, not arbitrary packages loaded by the model. Adding a new
provider therefore expands what Rat can safely expose without giving the guest a general credential
reader or a path to install its own authority.
