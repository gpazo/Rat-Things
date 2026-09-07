# How to schedule recurring Codex tasks in AWS

Schedule recurring Codex work by versioning the task definition, testing the exact draft, activating
that immutable revision, and letting Amazon EventBridge Scheduler submit an ordinary durable Run
for each occurrence. The schedule should select no arbitrary AWS role or target, and every run
should inherit a fixed capability envelope that is safe without a person watching.

> **Short answer:** schedule a tested agent definition, not a mutable prompt. Pin each occurrence to
> a revision and scheduled time so retries cannot silently change the work or create duplicates.

## Start with the risk of unattended work

A scheduled agent has no operator present to approve unexpected actions. Its definition therefore
needs to answer four questions before activation:

1. What exact goal and input will run?
2. Which revision is production using?
3. What shell, network, browser, AWS, and connected-account authority is available?
4. How will duplicate delivery, failure, and result retention behave?

A cron expression alone answers none of these. Treat scheduling as the final trigger attached to a
reviewed automation contract.

## Use an immutable task lifecycle

Rat Things calls a reusable cloud-agent definition a **Thing**. One stable Thing ID has immutable
revisions and separate draft and active pointers:

```text
edit draft → explain authority → test exact draft → activate exact revision → schedule Runs
```

Editing creates a new draft without changing production. Activation—called `publish` in the API and
CLI—requires a successful test Run for the same Thing ID, revision, and specification hash. The
active schedule remains pinned until another exact revision passes that gate.

For a complete lifecycle, see [Things: reusable cloud agents](../docs/things.md#lifecycle).

## Define the schedule

ThingSpec v1 supports EventBridge rate and cron expressions:

```json
{
  "version": "1",
  "name": "Weekday release readiness",
  "goal": "Return a concise release-readiness checklist covering tests, rollback, and go/no-go review.",
  "trigger": {
    "kind": "schedule",
    "expression": "cron(0 8 ? * MON-FRI *)",
    "timezone": "America/Los_Angeles"
  },
  "agent": {
    "driver": "codex",
    "sandbox": "read-only",
    "capabilities": {
      "profile": "read-only",
      "networkAccess": false,
      "webSearch": "disabled",
      "computerUse": "disabled"
    }
  },
  "execution": { "backend": "microvm", "timeoutSeconds": 300 },
  "deliver": [{ "kind": "none" }]
}
```

This minimal example needs no checkout or connected account. Before replacing the goal with real
release checks, configure the repository or inputs, required tools, and their capability envelope.

[Amazon EventBridge Scheduler's schedule-type documentation](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
defines cron and rate schedules, IANA time zones, daylight-saving behavior, and 60-second
invocation precision. EventBridge cron uses six fields and requires exactly one of day-of-month or
day-of-week to use `?`. Rat Things defaults the time zone to UTC and deliberately leaves one-time
`at(...)` expressions out of the current Thing contract.

Start from the checked-in [connected schedule example](../examples/thing-connected-schedule.json)
when browser use, an account selection, or result delivery is required.

## Test and activate the exact revision

Save the definition as `weekday-release.json`, then use the safe release path:

```bash
npm run rat-things -- thing-release --file weekday-release.json
```

That command creates the draft, explains its effective authority, stops on blocking diagnostics,
tests the exact draft, waits for success, and activates only the revision and `specHash` proven by
that test.

Do not enable a write-capable schedule merely because one test produced the expected prose. Inspect
the resolved capability envelope and durable tool-call ledger. Restrict connected accounts to the
exact read or write operations and resources required by every unattended occurrence.

## Make retries idempotent

EventBridge Scheduler supports retries and a dead-letter queue when target delivery fails. Rat
Things therefore assumes an occurrence can be delivered again and derives its idempotency identity from
the Thing ID, pinned active revision, and Scheduler-provided scheduled time. A retry therefore
converges on the same semantic Run instead of starting a second occurrence.

Before submission, the trusted target confirms that the Thing still exists, is active, still points
to the delivered revision, and still has a schedule trigger. A stale or paused delivery is
acknowledged without creating a Run.

The schedule cannot choose an arbitrary Lambda target or invocation role. Rat Things owns the
target, fixed role, retry policy, and encrypted failure queue.

## Pause and change production safely

Use lifecycle operations instead of editing AWS resources directly:

```bash
npm run rat-things -- thing-pause THING_ID
npm run rat-things -- thing-resume THING_ID
npm run rat-things -- thing-archive THING_ID
```

Pausing disables future scheduled delivery but does not cancel a Run already in flight. An explicit
manual `thing-run` still invokes the active revision while scheduling is paused. Archiving is
terminal and removes the schedule.

To change the goal or permissions, create a new draft, explain and test it, then activate it. Do not
edit the Scheduler target, role, or payload by hand; doing so bypasses the lifecycle Rat Things can
reason about and repair.

## Deliver a useful result

A recurring task needs a destination and a durable receipt. Each occurrence is an ordinary Run with
the same lifecycle as manual, API, Slack, or webhook work. A Thing can deliver its terminal result
to a supported destination, while the full result, events, and generated files remain available to
the authenticated owner.

Useful narrow schedules include:

- a read-only morning Slack decision digest;
- release-readiness checks that retain a report;
- an issue-triage summary that proposes rather than performs mutations; and
- a browser-based monitoring task restricted to approved public origins.

For consequential changes, schedule a read-only preparation Thing and submit a separate, narrowly
authorized execution Run after review. Rat Things has no mid-Run approval step.

## Evidence and limitations

| Evidence field | What is established |
| --- | --- |
| Date | August 23, 2026 |
| Source revision | Historical clean live-AWS suite recorded in the validation ledger; this guide was reviewed against `c0156cd` |
| Environment | Fresh 226-resource disposable stack in `us-west-2`; ARM64 Lambda MicroVM; Amazon EventBridge Scheduler |
| Model/provider | Deterministic mock driver; the proof tests schedule and Run orchestration without spending model tokens |
| Scenario | Create draft revision 1, test it, publish that exact revision, activate `rate(1 minute)`, observe one scheduled occurrence, pause, resume, reject stale/duplicate delivery, and archive |
| Result | The Run pinned the expected Thing ID, revision, scheduled time, and occurrence idempotency key; it succeeded and left the schedule failure queue empty |
| Reproduce | Use `npm run rat-things -- thing-release --file weekday-release.json`; the infrastructure case is the scheduled-Thing scenario in [the AWS workflow suite](../tests/aws/workflow.test.ts) |
| Evidence | [Dated scheduled-Thing validation](../docs/status-and-roadmap.md#validation-completed-on-2026-08-23) |
| Limits | This is a focused lifecycle proof, not sustained scheduling load, every injected retry/crash boundary, or an operations drill. Production still needs alarms, budgets, failure-queue exercises, and constrained egress. |

Continue with the [Thing schedule triage runbook](../docs/runbook.md#thing-schedule-triage).

## Sources

- [Amazon EventBridge Scheduler schedule types, time zones, and precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
- [Amazon EventBridge Scheduler retries and dead-letter queues](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule.html)
- [Rat Things Thing lifecycle and schedule contract](../docs/things.md)
- [Rat Things scheduled-Thing validation](../docs/status-and-roadmap.md#validation-completed-on-2026-08-23)
