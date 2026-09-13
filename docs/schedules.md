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
  "destinations": []
}
```

The `openai_hosted` discriminator is the upstream API spelling; this deployment
runs that managed environment in your AWS account. A `none` environment is also
available. Self-hosted executors must connect before the connection deadline.

Input templates recognize `{{scheduled_at}}` and `{{schedule_id}}`. The scheduled
instant is normalized to UTC. Retries reuse the occurrence's saved configuration
and Session ID. `overlap: "skip"` suppresses an occurrence while the previous
Session is active or awaiting creation; `"allow"` permits separate concurrent
Sessions. Paused schedules and stale generations accept no new occurrences.
Already accepted work continues with its saved configuration.

The CLI uses the same contract:

```bash
rat-things schedules create --file schedule.json
rat-things schedules list
rat-things schedules pause sched_example
```

## Provider bindings

Provider adapters verify signatures before parsing or saving input. Create an
owned Agent, then use `POST /v1/integrations/source-bindings` on the control endpoint:

```json
{
  "version": "1",
  "sourceKind": "slack",
  "selector": { "teamId": "T123", "channelId": "C123" },
  "agentId": "agent_example",
  "environment": { "type": "none" },
  "connectionSetId": "slack-notifications"
}
```

The most specific matching selector wins; equally specific matches are rejected.
Unbound events are acknowledged with `accepted: false` and `source_not_bound`.
The binding's authenticated creator owns the Session. The provider sender,
source thread and deployment credential subject retain separate identities.

Slack and Teams reuse a Session for the same provider, tenant, sender and thread.
Each GitHub or GitLab occurrence creates its own Session so its repository ref
cannot silently change an existing workspace. Repository events require a managed
environment; checkout still uses HTTPS host allowlists and host-side credential
references. No clone token is included in the Session input.

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
