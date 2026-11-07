# Export boundaries for the AWS controller

Export after the workload and its Lambda invocations have finished. Client response headers, a cancelled HTTP body and a completed controller cleanup do not independently establish Lambda completion. Keep the workload artifact beside the exports and cost report so request outcomes and measurement gaps remain auditable.

## Select the scope

For the current controller, use the entire isolated matrix as the primary cost window. It includes setup, initial model work, observers, submissions, manager drain polling and cleanup in the selected functions. Describe the resulting estimate as the matrix's measured collaboration subtotal. Do not describe it as idle-viewer cost or divide it into a universal per-collaborator price.

A per-scenario report is useful only if adjacent scenarios have no overlapping invocations or outbox work. `scenarios[].startedAt`, `finishedAt` and `phases[].atUtc` are client boundaries, not proof of a server drain. Attribute a window as isolated only when unrelated work is absent. If that cannot be shown, use `isolatedPhase: false` and keep the result partial.

Persistent observers open near `observers_connecting` and close during cleanup. One invocation can cover every round. A window from `round_N_prepared` to `round_N_complete` cannot isolate that round's actual billed duration. Do not allocate the invocation's cost by first-byte time or prorate its REPORT. Use a containing window, or label the narrow result partial and avoid marginal claims.

Prepare an export interval that starts before the first setup request and ends after the last relevant server REPORT and outbox completion. Fetch it again after delayed log delivery. Use the same fixed interval when reconciling repeated exports; ingestion delay does not change an event's timestamp. Do not assume a fixed wait proves all requests completed. Retain timeout and failed-request evidence if completion never appears.

## Export complete events

The deployment has three relevant functions. The controller's authenticated shared API uses `agents-shared`; its IAM operator setup uses `agents-api`; asynchronous work uses `agents-outbox`. Terraform names log groups `/aws/lambda/${local.name}-${each.key}`. Resolve the actual deployed names from existing deployment outputs. Do not substitute the code bundle name `agents-api` for the shared function's log group.

The following is an operator command template, not a command run by this review. Set the variables to the verified deployed log-group names, exact epoch-millisecond export interval and private output directory. Default AWS CLI pagination must remain enabled. Do not use `--no-paginate`, `--max-items`, a message filter or a query that drops event IDs/timestamps. Do not print raw exported messages into the report.

```sh
umask 077
aws logs filter-log-events --region us-west-2 \
  --log-group-name "$COST_SHARED_LOG_GROUP" \
  --start-time "$COST_EXPORT_START_MS" --end-time "$COST_EXPORT_END_MS" \
  --output json --no-cli-pager > "$COST_INPUT_DIR/shared.json"
aws logs filter-log-events --region us-west-2 \
  --log-group-name "$COST_OPERATOR_LOG_GROUP" \
  --start-time "$COST_EXPORT_START_MS" --end-time "$COST_EXPORT_END_MS" \
  --output json --no-cli-pager > "$COST_INPUT_DIR/operator.json"
aws logs filter-log-events --region us-west-2 \
  --log-group-name "$COST_OUTBOX_LOG_GROUP" \
  --start-time "$COST_EXPORT_START_MS" --end-time "$COST_EXPORT_END_MS" \
  --output json --no-cli-pager > "$COST_INPUT_DIR/outbox.json"
```

Keep START, END, REPORT, initialization/error lines and `rat.performance` records. Text and structured `platform.start`/`platform.report` formats are supported. END alone is not a compute-unit record. A request with a REPORT but no performance record contributes measured compute and leaves storage coverage partial. A START with no REPORT contributes no invented compute units and marks all components partial.

## Construct the manifest

Use ISO timestamps with timezones for the exact analysis interval. It can equal the complete export interval or select a narrower subset. Selection is half-open `[start, end)`. Supply actual deployed function names and architecture. The current Terraform functions are ARM64, but record the verified deployed configuration rather than assuming a future deployment uses it.

```json
{
  "schemaVersion": 1,
  "region": "us-west-2",
  "phase": "persistent-matrix-including-setup-and-cleanup",
  "start": "REPLACE_WITH_VERIFIED_WINDOW_START_UTC",
  "end": "REPLACE_WITH_VERIFIED_WINDOW_END_UTC",
  "isolatedPhase": false,
  "completeWindowExport": false,
  "sources": [
    { "function": "REPLACE-agents-shared", "architecture": "arm64", "files": ["shared.json"] },
    { "function": "REPLACE-agents-api", "architecture": "arm64", "files": ["operator.json"] },
    { "function": "REPLACE-agents-outbox", "architecture": "arm64", "files": ["outbox.json"] }
  ]
}
```

The placeholders intentionally fail timestamp validation until replaced. Set each completeness/isolation assertion true only when independently verified. Keep empty source exports; they remain unknown rather than silently removing that function's cost. If a function is deliberately out of scope, say so in the accompanying analysis.

Before raising completeness, reconcile unique START IDs, REPORT IDs and performance-scope IDs per function against controller requests and failures. Inspect `startsWithoutReport`, `missingReports`, `reportsWithoutScope`, `unidentifiedScopes`, `invalidRecords`, `crossingWindow` and `unknownStart`. Requests can fail before Lambda invocation, so controller attempt counts are a reconciliation input, not a mandatory equality with REPORT count. Invocations entirely absent from the export cannot be detected by the calculator.

Leave `viewerHours` absent for a mixed writer/observer matrix unless separately measured viewer occupancy supports a clearly labeled phase average. Client `observerHttpConnectionMs` is a sum across overlapping snapshot, authority, runtime and stream HTTP calls; it is not viewer-hours. `streamConnectionMs` is client stream occupancy and still excludes gaps in desktop playback. Neither is Lambda billed duration. For a pure viewer-hour study, measure unique connected viewer occupancy over the interval and use an otherwise matched zero-viewer baseline. Current matrix phases do not supply that baseline.

## Interpretation checks

- Submission acknowledgement ends at response headers. `ResponseHeadersDuration` is server header preparation. `RequestDuration` spans the completed server response. Neither replaces REPORT Billed Duration for compute. Client visibility/progress distributions stay separate from all three.
- Failed or conflicted DynamoDB transactions can consume capacity that is not returned. `DynamoCapacityMissing` and unclassified units remain partial. Do not infer zero from the failure or price transaction item counts as returned capacity.
- S3 multipart uploads bypass `measuredS3`. Successful measured GET/PUT counters are only the instrumented portion. Unknown multipart calls, retries, KMS and stored/versioned bytes remain excluded. A Share phase therefore cannot establish total S3 cost from these counters.
- The default log-only telemetry produces zero emitted EMF series. This says nothing about CloudWatch log ingestion/storage charges. Log bytes and custom-metric charges are excluded from the variable subtotal.
- No marginal viewer price should be reported without the matched baseline and complete listed-component coverage. An observed partial subtotal can still be useful when its boundaries and missing components accompany the number.
