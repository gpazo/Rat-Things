# How to schedule Codex or Pi Durable tasks in AWS

Create an Agent with the model, instructions and tools needed for the task. Then
create a schedule that references that Agent and its environment. Rat Things
stores the schedule in your AWS account and uses EventBridge Scheduler to submit
an occurrence to the Session integration service.

## Define the work

Choose the runtime on the saved Agent. Codex is the default. For Pi Durable,
set `metadata: { "rat_things_runtime": "pi" }` in the Agent request and select
an approved Bedrock model. The schedule uses that Agent's runtime when creating
its Session. See [Pi setup](run-pi-durable-on-bedrock.md).

Keep reusable behavior on the Agent and setup in an environment template. The
schedule supplies the input, time expression, overlap policy and destinations:

```json
{
  "name": "Weekday review",
  "agentId": "agent_example",
  "environment": { "type": "none" },
  "expression": "cron(0 8 ? * MON-FRI *)",
  "timezone": "America/Los_Angeles",
  "input": "Review the supplied release notes for {{scheduled_at}}.",
  "overlap": "skip",
  "destinations": []
}
```

Use a managed environment template when the Agent needs a filesystem or commands.
The upstream `openai_hosted` environment spelling selects your AWS-managed
execution in this deployment. Declare the required tools and credentials before
launch; unattended work has no approval step for extending authority.

Save the definition as `schedule.json` and use the authenticated control endpoint:

```bash
npm run rat-things -- schedules create --file schedule.json
npm run rat-things -- schedules list
npm run rat-things -- schedules pause sched_example
npm run rat-things -- schedules update sched_example --file schedule.json
npm run rat-things -- schedules resume sched_example
```

## Occurrences and retries

Each accepted occurrence reserves a Session ID and snapshots the schedule input
before asynchronous submission. Retries use that receipt. A later schedule edit
does not change already accepted input. The Agent itself is resolved and
snapshotted when the Session is first prepared.

`overlap: "skip"` suppresses a new occurrence while the previous Session is
`in_progress` or awaiting creation. `"allow"` permits concurrent Sessions. Pauses and stale
schedule generations reject new occurrences; already accepted work continues.

Terminal root Turns—including completion, failure and cancellation—deliver saved
output to configured destinations, independent of how long the harness remains
alive. Durable delivery fences suppress duplicate replies after ambiguous provider
outcomes.

The [schedule contract](../docs/schedules.md) describes supported expressions,
input substitutions, ownership and provider bindings. The deployment fixes the
EventBridge target and invocation role; schedule callers cannot select AWS roles.

## Current boundaries

Scheduling is a Rat Things integration extension linked to standard Agents and
Sessions. It has no separate executable-agent definition or release pointer.
A schedule stores an Agent reference; the Session snapshots that Agent at first
preparation. The environment and provider must support every requested tool.

## Frequently asked questions

### Can I schedule Codex or Pi Durable without leaving my laptop on?

Yes. An AWS deployment uses EventBridge Scheduler to submit work to owned Agents
and durable Sessions. The Agent's runtime, model, tools and environment must be
configured before the scheduled work starts.

### Does pausing a schedule cancel work it already accepted?

No. Pausing prevents new occurrences. Already accepted work continues under its
saved receipt; use the Session's control operations to manage that work.

## Sources

- [Rat Things schedule contract](../docs/schedules.md)
- [Agents, Sessions and environment configuration](../docs/agents-api.md)
