# Collaboration cost from exported logs

This tool estimates a measured variable collaboration subtotal from a bounded phase. It does not estimate a bill or a universal price per collaborator. Unknown components remain `null`, and the output lists costs that are excluded. Calculations and parsing are pure functions in `cost.ts`; file reads and output belong to `cli.ts`.

Use Node 22 from the repository root. The CLI makes no network calls and reads no AWS credentials.

```sh
node --import tsx testing/performance-cost/cli.ts \
  --manifest /absolute/path/phase.json \
  --rates testing/performance-cost/us-west-2-rates.json \
  --baseline /absolute/path/baseline.json > /absolute/path/cost.json
```

`--baseline` is optional. Without it, the marginal result is unavailable. `--help` prints the command shape. The rate card is always explicit.

## Inputs

A manifest identifies the exact phase window, functions, architecture and exported files. Paths in `files` are relative to the manifest. Combine paginated or overlapping exports for the same function in one source. Use separate sources for the API and outbox functions. Do not mix local logs into an AWS function source.

```json
{
  "schemaVersion": 1,
  "region": "us-west-2",
  "phase": "20-viewers-idle",
  "start": "2026-11-07T15:00:00Z",
  "end": "2026-11-07T15:05:00Z",
  "isolatedPhase": true,
  "completeWindowExport": true,
  "viewerHours": 1.6666666666666667,
  "sources": [
    { "function": "agents-api", "architecture": "arm64", "files": ["api-logs.json"] },
    { "function": "agents-outbox", "architecture": "arm64", "files": ["outbox-logs.json"] }
  ]
}
```

The times and viewer-hours above illustrate the schema. Replace them with measurements. Viewer-hours are the integral of connected viewers over time, divided by 3,600 seconds. A fixed count multiplied by phase duration is valid only when that count remained connected throughout.

Set `isolatedPhase` only when the functions did not serve unrelated work during the phase. Set `completeWindowExport` only after exporting every page and required log group. A continuation token is not proof of complete export. Missing functions, delayed logs and lost records cannot be detected from the exported subset alone.

Supported log formats are CloudWatch `filter-log-events`/`get-log-events` JSON with an `events` array, an array of timestamped events, or JSONL containing one timestamped event per line. Each event requires a numeric epoch-millisecond or ISO `timestamp` and a string `message`. Optional `eventId` and `logStreamName` aid deduplication. Raw un-timestamped text and CloudWatch Logs Insights result tables are rejected. Exported messages may contain text-prefixed Lambda JSON logs, JSON logging envelopes, text REPORT lines or JSON `platform.report` events.

Keep exported logs in the private validation directory. Output contains measured counters, bounded operation/outcome labels, function names and rate provenance. It does not copy raw messages, request IDs, prompts or credentials.

## Measurement boundaries

Selection uses the CloudWatch event timestamp in `[start, end)`. Each selected completed record contributes its entire usage. No billed duration is prorated across the window. A scope that began before the window is counted but marked partial. End streams, wait for REPORT delivery, then choose/export an isolated window containing the completed work. Open streams have no final performance record or REPORT yet. An event-only export cannot reveal all such invocations.

Lambda compute uses each unique REPORT's **Billed Duration**, divided by 1,000, multiplied by **Memory Size**, divided by 1,024. It never substitutes `RequestDuration`. Architecture comes from the explicit manifest. REPORT request IDs are correlated with the enclosing AWS log prefix/envelope of each performance record. Nested `share-transfer` scopes are not invocation counts. Records without IDs and REPORTs without a performance scope make coverage partial. Invocation request pricing counts one request per REPORT; extra request units for large asynchronous payloads are excluded.

DynamoDB uses actual classified read and write capacity returned by the SDK. Transaction capacity is already charged at its transaction rate; the calculator does not multiply it again. Missing responses, retries and `DynamoUnclassifiedCapacity` are disclosed. Unclassified units receive no dollar estimate. A missing metric is unknown; an explicit zero remains zero.

S3 counts are logical GET/PUT calls. Extra SDK attempts are aggregate counts without request class or billing-status attribution. The request subtotal therefore has uncertainty when retries or errors occur. Attempted write payload bytes and consumed read bytes are usage diagnostics, not storage or transfer charges. Multipart stream uploads are outside this instrumentation.

The subtotal adds only components with observed units. Partial components remain labeled partial. It excludes KMS, transfer, Lambda streaming bytes, CloudWatch logs/metrics, baseline infrastructure, stored/versioned objects, database storage/backups, worker compute, model tokens, SQS and other uninstrumented calls. Unknown costs are not silently assigned zero. Free tiers, credits, taxes, discounts and account-wide pricing tiers are not applied.

`customMetrics.observedEmfSeries` counts distinct emitted namespace/metric/dimension sets across all sources. It does not prove CloudWatch accepted the records, and it is not a monthly metric charge. Ordinary structured JSON without an EMF directive contributes no EMF series.

## Per-viewer interpretation

`computeAndRead.observedPhaseUsdPerViewerHour` is the observed phase average for Lambda compute/invocation requests, DynamoDB reads and S3 GETs. Inspect `completeForListedComponents` before using it. It excludes writes and all unmeasured costs. It is not marginal cost.

For a marginal estimate, supply a zero-viewer baseline manifest with `viewerHours: 0`, the same functions/architectures, a matched workload and the same rate card. The calculator subtracts baseline compute/read cost scaled by the ratio of window durations, then divides by measured viewer-hours. Repeat matched runs to assess noise. Negative differences remain negative instead of being clamped to zero.

The marginal result is `null` if any required function/component lacks complete measurement. In particular, an empty log file does not establish zero compute or zero reads. Do not manufacture a baseline by filling absent fields with zero. An isolated idle-viewer phase can still provide an explicitly partial observed phase average while baseline coverage is unavailable.

## Pinned rate card

The included rate card was retrieved from official AWS public regional offer files on 2026-11-07. Every rate records its URL, SKU, rate code, usage type, offer version, publication date, effective date and retrieval time. Prices are USD per unit.

| Component | Rate | Unit |
| --- | ---: | --- |
| Lambda ARM, first tier | 0.0000133334 | GB-second |
| Lambda x86, first tier | 0.0000166667 | GB-second |
| Lambda invocation | 0.0000002000 | request |
| DynamoDB standard on-demand read | 0.0000001250 | read request unit |
| DynamoDB standard on-demand write | 0.0000006250 | write request unit |
| S3 Standard GET | 0.0000004000 | request |
| S3 Standard PUT | 0.0000050000 | request |

Sources are the [Lambda us-west-2 offer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-west-2/index.json), [DynamoDB us-west-2 offer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-west-2/index.json) and [S3 us-west-2 offer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-west-2/index.json). The `current` URLs move; the committed metadata identifies the snapshot used. Update the explicit card when regional prices or pricing assumptions change.

## Verification

```sh
npx vitest run tests/performance-cost/cost.test.ts
npm run typecheck
```

Tests cover the real CLI, billed-unit conversion, transaction capacity, missing/ambiguous capacity, retries, JSON/text REPORTs, deduplication, window boundaries, privacy and baseline subtraction. They are synthetic correctness fixtures, not performance or cost measurements.
