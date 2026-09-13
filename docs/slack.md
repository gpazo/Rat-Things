# Use Rat Things from Slack

Slack is an ingress and delivery surface for Sessions. A signed mention resolves
an owned Agent binding, accepts a Session input and delivers the saved terminal
root Turn back to the source thread. The API, harness and storage run in your AWS
account.

## Start and continue work

The Slack adapter verifies the request signature and timestamp before normalizing
or accepting it. The source binding selects the owner, Agent and environment;
the caller cannot choose a different owner in the message body.

Mentions by the same sender in the same Slack thread continue that sender's
Session. A different sender does not inherit another sender's Session. Repeated
provider events reuse their reserved occurrence instead of creating duplicate
inputs. The Session's resolved configuration remains fixed across continuation.

For example, a user can request an initial analysis, then mention Rat Things again
in the same thread to refine it. The saved Session retains the earlier messages,
Turn outcomes and tool activity. Its environment may need reconnection or recovery
if the worker is no longer available.

## Receive results

Delivery reads the saved terminal root Turn and uses the configured Slack
connection to post to the original thread. Execution and delivery have separate
outbox work groups. A delivery failure does not run the agent again; an uncertain
provider acknowledgement is fenced instead of blindly repeated.

The Session and Turn IDs connect the Slack result to saved API history. Use the
console, CLI or API to inspect Items, send more input, cancel active work or retrieve
managed artifacts. Browser takeover and the former public Run/conversation API are
retired.

## Grant tools separately

A connection used to deliver a Slack answer does not give the agent Slack tools.
Standard Sessions receive only the tools declared in their Agent configuration.
For tool access, configure an explicit MCP connection or application function,
and provide credentials through the supported Vault/tool configuration.

Provider scopes, account grants, operation restrictions and resource constraints
still apply wherever the tool adapter enforces them. A denial must not create an
approval that widens the Session's authority. Starting from Slack does not bypass
those controls.

## Schedules and installation

A schedule references an Agent and environment and may select a Slack result
destination. Scheduled work uses the same Session execution and terminal delivery
boundaries. See [schedules and provider bindings](schedules.md).

Use [Channels and provider adapters](channels.md#slack-self-hosted-channel-adapter)
for installation, signature handling and acknowledgement behavior. Use
[Integrations, accounts and permissions](plugins.md) for connection administration,
and [Agents API](agents-api.md) for declared tools, Vaults and Session requests.
