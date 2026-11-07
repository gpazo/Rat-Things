# Independent telemetry review

The user needs measured collaboration costs before expanding load. This review checks production telemetry at `68c06ca8ead69020462f2a62b593934a3607826b` and the calculator based on `c3f82c565097347fbf1a73626d85fd9127ee7dba`. Production code was read only. No authenticated AWS calls, credentials, worker invocations or production edits were used.

## Finding

**P2. Default EMF emission creates recurring custom-metric series beyond the per-request log cost.** `src/core/performance.ts:81` at the reviewed commit emits a CloudWatch metric directive for every observed counter with dimensions Deployment, Component, Operation and Outcome. Eight operations and five outcomes permit 80 series for RequestCount and RequestDuration alone in one deployment. Conditional storage, activity and Share counters create more. Deployment names multiply the set. This is bounded cardinality, but it is an avoidable default cost for a measurement exercise.

Keep structured `rat.performance` JSON and SDK capacity measurement enabled. Make the `_aws.CloudWatchMetrics` directive an explicit opt-in. Preserve a start timestamp outside `_aws` when disabling EMF, so the calculator can still detect window crossings. A small allowlist of operational metrics can be enabled separately after the observed series count is known. No authorization or storage behavior needs to change.

**Resolved in `108f670e3e4a4895fc00e5298983e8bb59eddfc6`.** The parent added `enable_collaboration_metrics = false`, an explicit `RAT_PERFORMANCE_EMF` switch and top-level `StartedAt`. Read-only review of that commit confirms no measurement information loss when EMF is disabled. All existing counters, operation/outcome labels, request duration and start timestamp remain in JSON. The calculator accepts top-level `StartedAt` and the previous `_aws.Timestamp` shape. A CLI fixture verifies complete correlation and zero emitted EMF series with the new shape.

The official [CloudWatch us-west-2 offer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/us-west-2/index.json), retrieved 2026-11-07, gives $0.3000000000 per metric-month for the first 10,000 custom metrics. Offer version is `20261104213532`, publication date `2026-11-04T21:35:32Z`, effective date `2026-11-01T00:00:00Z`, SKU `CN6TP6ZEVS58RK7M`, rate code `CN6TP6ZEVS58RK7M.JRTCKXETXF.A6VD9GXV7W`. Eighty full-month series would be $24 before allowances and tiers. This is a sensitivity calculation, not a charge for a short burst. Actual publication hours and account pricing determine charges. The calculator reports observed unique emitted series and excludes their monthly cost.

## Other review results

No actionable authority change or prompt/token disclosure was found in the reviewed patch. Metric names and route categories are static. AsyncLocalStorage separates concurrent scope counters. Finishing a scope is idempotent, and sink failure does not affect the request outcome. No mutable authorization decision is cached.

DynamoDB uses `ReturnConsumedCapacity: TOTAL`; classified read/write units are reported without multiplying transaction cost again. Failed calls lacking capacity are counted in `DynamoCapacityMissing`. Write capacity that lacks read/write classification is retained as unclassified. `$metadata.attempts` covers SDK attempts, while logical call counts and actual returned capacity remain separate.

The following are measurement boundaries, not invented zero-cost components.

- S3 `putStream` multipart uploads and DynamoDB adapters outside `DynamoAgentsStore` are uninstrumented. The function subtotal is partial even when every emitted record is present.
- S3 write bytes are attempted payload bytes; read bytes are consumed body bytes. They cannot establish stored/versioned bytes or billable transfer. Error status classes and retry classes are not available for exact S3 request billing.
- API metrics finish when the streaming response ends. Open streams are absent from final records and REPORT-based compute until they close. Export after closure and delayed log delivery.
- Outbox measurement covers a batch. Allocate costs by an isolated workload window, not by dividing batch cost arbitrarily among inputs.
- Share quiesce timing includes snapshot work. Do not add all Share phase durations as if they were disjoint.
- ResponseHeadersDuration measures server-side header preparation. It is not client-observed time to first byte.
- An end-of-window REPORT can contain a whole invocation that began before the load window. The calculator keeps its actual units and marks boundary coverage partial rather than prorating.

## Verification model

Model the Domain led to typed measured components with explicit unknown values. Boundary Discipline kept file I/O in the CLI and parsing/calculation pure. Explain the Number led to REPORT-based compute, capacity coverage, retry uncertainty and a required measured zero-viewer baseline for marginal pricing. Prove It Works led to execution of the actual CLI from exported synthetic logs, alongside unit conversion and ambiguity tests. Synthetic fixtures verify arithmetic and parsing; they are not a load measurement.

## Coverage follow-up

A read-only comparison with integrated main `15019c31a9501a42e3f94954754aaf9d28ffe52e` found two coverage gaps in the calculator. A START-only invocation was ignored, and a REPORT without a performance scope made compute partial while leaving measured storage components labeled observed. A completed request plus a second START-only request could therefore produce an incorrect complete listed-component flag.

The follow-up recognizes text START and JSON `platform.start`, counts unmatched in-window starts, and propagates invocation gaps to every component. Observed dollars are unchanged; unknown invocation usage is never fabricated. Out-of-window starts are not invented. Existing `StartedAt` checks still mark completed crossing-window scopes partial. Nineteen focused cost tests passed, including the actual CLI and new START/REPORT coverage regressions. No AWS calls, live benchmarks or full-suite work ran during this follow-up.

The [export guide](export-guide.md) describes matrix/scenario boundaries, all three function log groups, completion reconciliation and why client first-byte/stream occupancy cannot establish billed duration or a marginal viewer price.
