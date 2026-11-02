# Watchdog

The watchdog inspects Session activity on its own schedule and reports problems through
existing delivery destinations and Session webhooks. It has a separate Lambda and IAM
role. Its reports do not depend on the Agents outbox being enabled or healthy.

## Enable and configure

Add these settings to the deployment's Terraform variables and apply the configuration:

```hcl
enable_watchdog               = true
watchdog_schedule_expression  = "rate(10 minutes)"
watchdog_max_judges_per_tick   = 3
watchdog_allow_cancel         = false
```

The watchdog is disabled by default. When enabled, it reports findings and can retry eligible
transient failures; the example leaves loop cancellation off. Set
`watchdog_max_judges_per_tick = 0` to disable model judgments while retaining collection,
reporting and the fixed retry policy. `watchdog_model = null` uses the deployment's default
approved model. With judging enabled, the selected model must belong to that catalog and
support the Codex judge's structured output.

| Terraform setting | Default | Accepted values |
| --- | --- | --- |
| `watchdog_long_running_seconds` | 1,800 (30 minutes) | 60–604,800 |
| `watchdog_stuck_seconds` | 1,800 (30 minutes) | 60–604,800 |
| `watchdog_recent_failure_seconds` | 86,400 (24 hours) | Retry backoff through 604,800 |
| `watchdog_retry_backoff_seconds` | 120 | 1–86,400 |
| `watchdog_max_candidates` | 25 | 1–100 |
| `watchdog_max_judges_per_tick` | 3 | 0–10 |
| `watchdog_judge_timeout_seconds` | 1,800 | 60–86,400 |
| `watchdog_retention_seconds` | 2,592,000 (30 days) | 86,400–31,536,000 |
| `watchdog_loop_confidence` | 0.9 | 0.9–1 |
| `watchdog_allow_cancel` | `false` | `true` or `false` |

Each invocation inspects a bounded slice of storage and saves a cursor for the next invocation.
`watchdog_max_candidates` limits new findings per tick and controls collection page size.
Large deployments can take several intervals to inspect fully. Choose age thresholds that
allow normal builds and provider delays before treating activity as overdue.

## Findings and judgments

The collector looks for long-running root Turns, recent transient failures, pending
Session dispatch receipts, overdue provider and webhook delivery, quarantined private
executions, and four deployment CloudWatch alarms: the run DLQ, state-stream failures,
notifier delivery failures and notifier DLQ delivery failures. `watchdog_long_running_seconds`,
`watchdog_recent_failure_seconds`, and `watchdog_stuck_seconds` set their age thresholds.

Long-running Turns receive a bounded digest containing tool names and counts, the largest
count of identical calls, and the last assistant text, truncated to 600 characters. The
digest samples at most 100 Items. Arguments are used only to compare calls and are not
retained in the digest. Tool outputs, credentials, and connection details are excluded.
Known credential values are redacted at the Session output boundary; the digest also
redacts common credential signatures and URLs.

Only long-running findings receive a model judgment, within the configured per-tick limit.
A judge runs as a normal Session owned by the affected Session owner. It uses
`environment: { "type": "none" }`, no tools, no vaults, and no subagents. Its fixed
structured response contains `verdict`, `confidence`, and short `evidence` strings. The
verdict is one of `progressing`, `looping`, `drifting`, or `blocked`. Judge output never
selects a tool or authorizes an action.

The deterministic finding is reported while the judge runs. A completed judgment
produces an updated report. Judge failure, invalid output, or timeout preserves the
original finding. `watchdog_model` selects an approved deployment model;
`watchdog_max_judges_per_tick` bounds new judge Sessions and can be zero to disable
judging. `watchdog_judge_timeout_seconds` limits elapsed judgment time. An overdue judge
receives a cancellation request on the next inspection.

Reports identify the judge Session. Retrieve its Items and Turns through the regular
Session API to inspect the assessment afterward. Findings are stored in the
`watchdog_findings` collection under the affected owner, with encrypted S3 content and
DynamoDB references. `watchdog_retention_seconds` controls their TTL. Deployment alarms
and scan checkpoints use `watchdog_owner_id`, which defaults to `watchdog-operator`.

## Fixed action policy

A failed Turn can receive one automatic retry when its error is `rate_limit_exceeded`,
`server_overloaded`, `connection_failed`, `server_error`, or `request_timeout`. The
watchdog waits at least `watchdog_retry_backoff_seconds`, requires complete saved Items
with no tool call, and requires the failed Turn to remain the latest Turn. The failure
must be within `watchdog_recent_failure_seconds`, with a nonempty accepted input and an
open Session that is neither failed nor locked for a fork. Judge Sessions are excluded.
An ineligible retry is reported as `ineligible`. An eligible retry resubmits
the original accepted input as a new Turn through the ordinary Session dispatcher.
A durable receipt prevents duplicate retries, including after a lost acknowledgement.
A failed automatic retry is never retried again. Retries count toward the owner execution
rate limit. If that limit is exhausted, the retry stays pending for a later inspection
and must still satisfy the eligibility rules then. Cancellation does not consume admission capacity.

Authentication, cyber-policy, budget, usage-limit, credit, and other failures do not
qualify. Incomplete Item history also prevents a retry. The judge cannot override these
rules.

Loop cancellation is disabled by default. Enabling it requires both
`watchdog_allow_cancel = true` in deployment configuration and an explicit setting on
the source binding or schedule:

```json
{ "watchdog": { "cancelLoops": true } }
```

Place `watchdog` at the top level of the [source-binding or schedule request](schedules.md).
The examples there use `cancelLoops: false`; change it to `true` only for work you want
the watchdog to cancel. For an existing schedule, replace its configuration through
`PUT /v1/schedules/{scheduleId}`. Source-binding policy must be chosen at creation.

A looping verdict must meet `watchdog_loop_confidence`, which is at least 0.9. The
identified Turn must still be the latest active Turn and its current digest must match the judged
digest. Cancellation uses the normal Session receipt and dispatcher. Other verdicts
remain reports.

## Delivery

Provider Session findings reuse the Session integration's destinations and connection
set. `watchdog_destinations` supplies destinations for deployment findings and Sessions
without an integration. An empty destination list still retains findings and permits
configured Session webhooks.

To receive Session findings in your application, create an owned webhook endpoint with
`POST /v1/webhooks` on the API service:

```json
{
  "url": "https://app.example.com/webhooks/agents",
  "events": ["agent.session.watchdog"]
}
```

Store the returned signing secret and verify requests as described in
[Session webhooks](agents-api.md#session-webhooks). The event's `data` has this shape:

```json
{
  "id": "sess_example",
  "watchdog": {
    "finding_id": "versioned_report_id",
    "reason": "long_running",
    "judge_session_id": null,
    "verdict": null
  }
}
```

Session reasons are `long_running`, `transient_failure`, `outbox_stuck`, `delivery_stuck`
and `quarantined`. `judge_session_id` is null until a judge Session exists; `verdict` is
null until a judgment completes. Confidence, evidence and retry/cancellation status appear
in destination report text, not in this webhook object. Use the judge Session's saved
Items to inspect its assessment.

A later report version, such as a completed judgment, emits another event with a new
event ID and version-specific `finding_id`. Deduplicate retries by webhook event ID;
do not discard all later events for the same Session. Deployment alarms have no Session
and use `watchdog_destinations` only.

The same signing, endpoint verification, delivery receipts and 72-hour retry horizon
used by other Session webhooks apply. The watchdog delivers directly and retries pending
reports on later scans. A failed destination does not prevent the webhook attempt.

The watchdog does not repair credentials, increase budgets, change capability envelopes,
or grant itself access. Its host role can inspect deployment state and invoke the
existing Session and delivery services; judge Sessions receive none of that authority.
