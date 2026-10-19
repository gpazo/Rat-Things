# Codex and Pi Durable

Rat Things integrates two agent runtimes behind the same Session API. A runtime
runs the model and tools. Rat Things owns the surrounding AWS workers, saved state,
permissions, input delivery, and results.

Codex is the default. Pi Durable is available when the deployment has an approved
Bedrock model catalog. Choosing Pi does not require a ChatGPT login.

## One platform, two runtimes

Both runtimes use Agents, Sessions, Turns, and Items. The API, CLI, and desktop
console expose the same resources. Schedules and provider bindings can start work
from a saved Agent configured for either runtime.

Rat Things resolves tools and permissions before launch. Both runtimes run under
a separate non-root identity in isolated AWS compute. Built-in integration credentials
and service-origin MCP credentials stay behind host-side brokers. Environment-origin
MCP can expose its configured credentials to the environment process. An agent cannot
expand its own access during a Turn; see the [credential boundaries](security.md).

| Capability | Codex | Pi Durable |
| --- | --- | --- |
| Model access | Deployment-configured ChatGPT bridge or Bedrock | Approved Amazon Bedrock Converse models |
| Session selection | Default or `rat_things_runtime: 'codex'` | `rat_things_runtime: 'pi'` |
| Function tools, MCP, and subagents | Supported | Supported |
| Environments | None, managed, or self-hosted | None or managed; managed requires S3 Files and checkpoints |
| Standalone local execution | Supported | Uses durable Sessions |
| Hosted skills and plugins | Supported where configured | Unsupported |
| JSON-schema output, deferred functions, and built-in web search | Supported where configured | Unsupported |
| Runtime model discovery | `GET /v1/models` | `GET /v1/models?runtime=pi` |

Models and capabilities depend on the installed deployment. Pi's catalog reports
accepted inputs and reasoning settings. A catalog entry does not grant Bedrock
access or guarantee model availability in every AWS account or region.

## Select a runtime once per Session

An explicit Session selector takes priority over the saved Agent's selector.
If neither selects a runtime, Rat Things uses Codex. The server pins that choice
before preparing an environment. Updating metadata does not switch the runtime,
and forks inherit the source runtime. Create a new Session to change runtimes.

Pi Sessions also pin an approved model catalog. Each accepted Turn retains its
selected model. You can change the model within that catalog while the deployment
still permits it. The server does not silently substitute another model.

The desktop places **Runtime** before **Model**. The CLI uses `--runtime codex` or
`--runtime pi`. Read an existing selection with `rat-things sessions runtime SESSION_ID`.
See the [API reference](agents-api.md#choose-a-session-runtime) for request shapes
and the complete settings restrictions.

## How Pi Durable and Rat Things work together

[Pi Durable](https://earendil.com/posts/pi-durable/) provides checkpointed model
and tool tasks, conversations, and storage interfaces. Rat Things connects that
engine to its AWS state store and execution lifecycle. It also implements durable
subagent coordination on top of Pi's task and conversation support.

The worker waits for the host to acknowledge a native commit before applying it
locally. Native state is stored through encrypted S3 with DynamoDB ownership and
revision checks. Recovery gives a replacement worker a new ownership version.
Writes from the old owner are rejected.

Accepted input, pending function calls, saved results, and child relationships can
survive replacement. Background child work can continue after the root Turn ends.
Recovery waits for the prior worker's termination to be confirmed and uses a bounded
retry policy. Saved state does not guarantee that every failure can be recovered.

External effects need their own retry rules. An interrupted unsafe tool call is
reported as interrupted rather than automatically repeated. A missing reply from
an external service does not prove that its write failed.

## Conversation state and workspace files

Pi's native commits preserve agent state separately from workspace files. A Session
with environment `none` can use function and MCP tools without a managed workspace.
Managed Pi environments require both S3 Files and `session_checkpoints_enabled`.
They retain flushed workspace files and setup identity after verified worker
termination. A successful tool result is committed after its workspace flush.

Codex preserves native journals through its configured durable home. Its workspace
handoff also requires an available committed checkpoint. Ordinary replacement can
reset sandbox files. Neither runtime restores a running process or an open socket
from a file checkpoint. Saved Session artifacts have a separate retention lifecycle.

Read [Session durability](conversations.md#how-durability-works) and
[environment recovery](agents-api.md#resource-model) for the storage boundaries.

## Start with the appropriate setup

- [Run Pi Durable on Bedrock](../guides/run-pi-durable-on-bedrock.md) configures the Pi catalog and creates a Session.
- [Bring your Codex subscription](codex-subscription.md) describes the optional ChatGPT credential bridge.
- [Deployment configuration](../infra/README.md#enable-pi-inference) describes Pi model IDs, inference resources, and IAM permissions.
