# Schedules and provider Sessions

A schedule references an owned Agent and an environment. Agent model, instructions
and tools remain on the Agent; setup remains in an environment template. Rat Things
stores schedule state in its encrypted AWS resource store and synchronizes
EventBridge Scheduler asynchronously.

Use the authenticated control endpoint:

- `POST /v1/schedules` creates a schedule.
- `GET /v1/schedules` lists schedules with `after` and `limit` cursors.
- `GET /v1/schedules/{scheduleId}` retrieves one schedule.
- `PUT /v1/schedules/{scheduleId}` replaces its configuration.
- `POST /v1/schedules/{scheduleId}/pause` and `/resume` change its status.
- `DELETE /v1/schedules/{scheduleId}` marks it deleted and removes its AWS trigger.

```json
{
  "name": "Daily review",
  "agentId": "agent_example",
  "environment": {
    "type": "openai_hosted",
    "environment_template_id": "envtmpl_example"
  },
  "expression": "cron(0 9 * * ? *)",
  "timezone": "America/Los_Angeles",
  "input": "Review changes for {{scheduled_at}}.",
  "overlap": "skip",
  "destinations": [],
  "watchdog": { "cancelLoops": false }
}
```

The `openai_hosted` discriminator is the upstream API spelling; this deployment
runs that managed environment in your AWS account. A `none` environment is also
available. Self-hosted executors are unsupported. Pi managed environments require
S3 Files and Session checkpoints.

Schedules inherit the Agent's runtime unless the schedule sets `"runtime": "codex"`
or `"runtime": "pi"`. Each accepted occurrence pins its runtime choice for retries.

Expressions use EventBridge `rate(...)`, `cron(...)` or `at(...)` syntax; `timezone`
is an IANA time zone. Input templates recognize `{{scheduled_at}}` and `{{schedule_id}}`.
The scheduled instant is normalized to UTC. Retries reuse the occurrence's saved configuration
and Session ID. `overlap: "skip"` suppresses an occurrence while the previous
Session is `in_progress` or awaiting creation. A Session in `requires_action` does
not suppress the next occurrence. `"allow"` permits separate concurrent Sessions.
Paused schedules and stale generations accept no new occurrences.
Already accepted work continues with its saved configuration.

The CLI uses the same contract:

```bash
rat-things schedules create --file schedule.json
rat-things schedules list
rat-things schedules pause sched_example
```

## Provider bindings

Provider adapters authenticate requests before parsing or saving input. Create an
owned Agent, then use `POST /v1/integrations/source-bindings` on the control endpoint:

```json
{
  "version": "1",
  "sourceKind": "slack",
  "selector": { "teamId": "T123", "channelId": "C123" },
  "agentId": "agent_example",
  "environment": { "type": "none" },
  "connectionSetId": "slack-notifications",
  "watchdog": { "cancelLoops": false }
}
```

The most specific matching selector wins; equally specific matches are rejected.
Choose `threadScope` and any `watchdog` policy before creating the binding. The control API lists
and creates source bindings and can [replace their event policy](channels.md#change-an-event-policy).
It does not edit other binding fields or delete bindings.
See [event policies](channels.md#event-policies-and-quiet-responses) for a complete candidate binding.
`watchdog.cancelLoops` defaults to false. Enabling it also requires deployment opt-in;
see the [watchdog action policy](watchdog.md#fixed-action-policy).
Unbound events are acknowledged with `accepted: false` and `source_not_bound`.
The binding's authenticated creator owns the Session. The provider sender,
source thread and deployment credential subject retain separate identities.

Slack and Teams reuse a Session for the same provider, tenant, sender and thread.
Set `threadScope` to `thread` on a source binding to share the Session across senders
in that thread. The default is `sender`. Every input retains its actor attribution.

GitHub pull requests and GitLab merge requests retain one active Session per binding
and repository thread. Follow-up comments from actors in `eventPolicy.actors.allow` continue its
existing workspace. Comments require this allowlist even when triggered or subscribed. A head
change starts a new review Session and transfers the thread subscription, so a new
commit never silently replaces the checkout of an existing Session. Repository events
require a managed environment and HTTPS host allowlists. Clone credentials stay on
the host.

### Thread ownership and release

A provider Session can call `rat_things_thread_release({"reason":"Work is complete"})`.
The host resolves the current Session's subscription. The tool cannot select a
subscription, subscribe to another thread, or change authority. An operator can list subscriptions with `GET /v1/integrations/thread-subscriptions`
and inspect one with `GET /v1/integrations/thread-subscriptions/{id}`. The list
supports `after` and `limit` pagination. To release that subscription,
call `POST /v1/integrations/thread-subscriptions/{id}/release` with `reason` and the
current `epoch`. For example, after reading epoch `0`, send this JSON body:

```json
{ "reason": "Hand this thread back for a fresh request", "epoch": 0 }
```

A stale epoch returns `409` without releasing a later Session. Read the subscription again
before deciding whether to release its new owner. Reasons must contain 1–1,024 characters.
The current Turn can still deliver its reply after release. The next accepted event
starts a new Session. Deleting the subscribed Session has the same effect.

The subscription record identifies the current Session and its `epoch`, a generation that
advances when a new Session takes over. After 128 accepted inputs, the next event also starts
a fresh Session. Each Session integration records its predecessor and successor so operators
can follow the thread's history. Old delivery IDs remain deduplicated across these transitions.

Each occurrence has a durable input receipt. Repeated deliveries do not append
input twice. Messages received during an active Turn steer that Turn; later
messages create a new Turn. Root Turn completion, failure or cancellation triggers
provider delivery independently of the harness lifetime. Saved output and delivery
fences survive retries. Provider delivery uses a separate queue group, so a slow
provider cannot block Session execution.

`connectionSetId` grants notification access only. It does not add undeclared
agent tools. Use `vaultIds` to attach owned Vaults and declare MCP or function tools
on the Agent itself.

For Slack workspace setup, the CLI requires an explicit Agent:

```bash
rat-things slack-events slack-work --agent-id agent_example
```

Add `--environment-template envtmpl_example` for managed execution. Repeating the
command with the same Agent, environment and connection reuses the binding.
