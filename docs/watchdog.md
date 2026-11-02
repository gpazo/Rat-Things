# Watchdog

The watchdog inspects Session activity on its own schedule and reports problems through
existing delivery destinations and Session webhooks. It has a separate Lambda and IAM
role. Its reports do not depend on the Agents outbox being enabled or healthy.

Enable it with `enable_watchdog = true`. The default schedule is `rate(10 minutes)`;
`watchdog_schedule_expression` changes the cadence. The watchdog remains disabled by
default. Each invocation inspects a bounded slice of storage and saves a cursor for the
next invocation. Large deployments can therefore take several intervals to inspect fully.

## Findings and judgments

The collector looks for long-running root Turns, recent transient failures, pending
Session dispatch receipts, overdue provider and webhook delivery, quarantined private
executions, and deployment CloudWatch alarms. `watchdog_long_running_seconds`,
`watchdog_recent_failure_seconds`, and `watchdog_stuck_seconds` set their age thresholds.
`watchdog_max_candidates` bounds the work per invocation.

Long-running Turns receive a bounded digest containing tool names and counts, the largest
count of identical calls, and the last assistant text, truncated to 600 characters. The
digest samples at most 100 Items. Arguments are used only to compare calls and are not
retained in the digest. Tool outputs, credentials, and connection details are excluded.
Known credential values are redacted at the Session output boundary; the digest also
redacts common credential signatures and URLs.

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
and scan checkpoints use `watchdog_owner_id`.

## Fixed action policy

A failed Turn can receive one automatic retry when its error is `rate_limit_exceeded`,
`server_overloaded`, `connection_failed`, `server_error`, or `request_timeout`. The
watchdog waits at least `watchdog_retry_backoff_seconds`, requires complete saved Items
with no tool call, and requires the failed Turn to remain the latest Turn. It resubmits
the original accepted input as a new Turn through the ordinary Session dispatcher.
A durable receipt prevents duplicate retries, including after a lost acknowledgement.
A failed automatic retry is never retried again.

Authentication, cyber-policy, budget, usage-limit, credit, and other failures do not
qualify. Incomplete Item history also prevents a retry. The judge cannot override these
rules.

Loop cancellation is disabled by default. Enabling it requires both
`watchdog_allow_cancel = true` in deployment configuration and an explicit setting on
the source binding or schedule:

```json
{ "watchdog": { "cancelLoops": true } }
```

A looping verdict must meet `watchdog_loop_confidence`, which is at least 0.9. The
identified Turn must still be active and its current digest must match the judged
digest. Cancellation uses the normal Session receipt and dispatcher. Other verdicts
remain reports.

## Delivery

Provider Session findings reuse the Session integration's destinations and connection
set. `watchdog_destinations` supplies destinations for deployment findings and Sessions
without an integration. An empty destination list still retains findings and permits
configured Session webhooks.

Subscribe a webhook endpoint to `agent.session.watchdog`. Its event data contains the
Session ID and a `watchdog` object with `finding_id`, `reason`, `judge_session_id`, and
`verdict`. The same signing, endpoint verification, delivery receipts, and bounded retry
horizon used by other Session webhooks apply. The watchdog calls fanout and delivery
directly and retries pending reports on later scans. A failed destination does not
prevent the webhook attempt.

The watchdog does not repair credentials, increase budgets, change capability envelopes,
or grant itself access. Its host role can inspect deployment state and invoke the
existing Session and delivery services; judge Sessions receive none of that authority.
