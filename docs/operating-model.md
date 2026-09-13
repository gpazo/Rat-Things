# How Rat Things operates

Rat Things implements the OpenAI Agents API on infrastructure you own. The HTTP
service, agent harness, session storage, encrypted files, credentials and isolated
execution all remain in your AWS account. The configured model provider receives
inference requests; OpenAI does not operate the Rat Things control plane.

<figure class="doc-visual doc-visual-wide">
  <a href="product-overview.svg"><img src="product-overview.svg" alt="Your product, agent or event sends work to Rat Things in your AWS account and receives durable replies, files and URLs."></a>
  <figcaption><strong>Work and results stay in the backend you own.</strong></figcaption>
</figure>

## Work follows an Agent and Session

Create an Agent with a model, instructions and declared tools. Create a Session
from that Agent, select an environment and provide input. The Session snapshots
its resolved configuration so later Agent edits do not change existing work.

Input to an idle Session starts a Turn. Input during active work steers that Turn.
Turns complete, fail or cancel independently of the Session. Saved Items and Turns
let clients recover after a stream disconnect. The live SSE feed is not a replay
log; read saved resources when reconnecting.

| Resource | Responsibility |
| --- | --- |
| Agent | Reusable model, instructions, tools and delegation settings |
| Session | Configuration snapshot and durable work across Turns |
| Turn | One period of agent work |
| Item | Saved message, tool call, result or public reasoning summary |
| Environment template | Reusable setup, files and capabilities |
| Environment | Connected command and filesystem context |
| Vault | Write-only credentials for declared destinations |
| File, Skill and Artifact | Uploaded inputs, versioned capabilities and retained outputs |

See the [Agents API guide](agents-api.md) for SDK examples and exact behavior.
The console and canonical CLI groups use the same resource models.

## Integrations remain separate

Signed provider events resolve an owned Agent binding and add input to a Session.
Schedules reference an Agent and environment, with their own occurrence identity,
input template, overlap policy and delivery destinations. Provider delivery follows
a completed root Turn and has a separate retry queue group.

Connections retain provider installation, OAuth, verification, grants and secret
brokering. A notification connection does not automatically grant the Agent tools.
Declare the tools and attach the required Vaults explicitly. See
[schedules and provider bindings](schedules.md) and [connections](plugins.md).

## The host owns authority

The host authenticates people and services. Rat Things derives resource ownership
from that trusted principal; callers cannot select another owner. Provider sender,
resource owner, credential subject and notification destination stay distinct.

The host admits a fixed capability envelope before launch. Agent tools,
environment policy, IAM, network restrictions, provider scopes and connection
grants can each restrict operations. Agents act autonomously within that envelope;
there is no mid-Turn approval mechanism to widen it. Secrets remain outside
Agent/Session definitions, logs and model-visible requests.

## Existing application capabilities

Publication, sharing and browser administration still have consumers of the
former Run/conversation API while those integrations move to Session artifacts.
Use the Agents API for new work. Private Run records continue to track isolated
execution, dispatch, heartbeat and termination beneath Sessions.

Start with the [quickstart](quickstart.md), [agent operating guide](agents.md),
[deployment guide](development-and-deployment.md) or [control integrations](api.md).
