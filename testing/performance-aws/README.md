# Shared Session AWS performance controller

This opt-in controller measures a real Cognito-authenticated shared Session and
the deployed Agents API. It creates distinct writers and viewers, uses a fixed
execution role with no tools and `environment: none`, and asks the configured
real model for one-word replies. It does not deploy infrastructure or collect
CloudWatch billing data. Ordinary tests never invoke AWS.

The controller rejects GPT-6 Astra and requires an explicitly configured
GPT-6 Luna or GPT-5.6 Luna model ID. Choose one supported by the deployment region and endpoint. Workload inputs are capped at 41, setup Session inputs at
3, controller HTTP client retries are disabled, and the prompt requests a one-word
reply. The artifact fails if observed assistant output for any Turn exceeds 256
UTF-8 bytes. This observation guard does not impose a provider token limit before
generation. The API has no per-agent output-token limit; provider retry behavior is
also controlled by the deployed runtime. Verify both in preflight and budget for
the unbounded output/retry exposure before any live run.

Source the disposable deployment's `runtime.env` using the existing AWS harness
instructions. The controller requires all three live opt-ins plus the fixture,
region, admitted model, shared API URL, and IAM operator API URL:

```sh
AWS_E2E=true AWS_E2E_SHARED_SESSIONS=true AWS_E2E_REAL_CODEX=true \
  node --import tsx testing/performance-aws/controller.ts \
  --output /absolute/path/aws-performance.json
```

The default matrix is `1x1`, `10x10`, and `20x20`, where the first number is
simultaneous writers and the second is viewers. `20x50` remains available as an
individual scenario. Each scenario creates its own space and shared Session.
One burst is the default. Narrow the matrix or explicitly request rounds within
the 41 workload and 3 setup input caps.
Each round waits for the previous Turns and input outboxes to settle. The initial
Session input also runs to completion before measurement. This establishes a
history baseline; it does not prove the next Lambda or model request is warm.
`initialSession` retains creation acknowledgement, first manager-observed output
and completion timings for that setup Turn. Its observations use 500 ms snapshot
polling plus request latency; null output time means it was not observed.

Keep the real owner rate limit unchanged. Additional rounds may produce HTTP 429;
concurrent submissions may expose conditional-write contention. The controller
records every rejected request without retrying or removing it from the report.
It continues the matrix, writes a failed status when requests or observations
fail, and exits nonzero after cleanup. `--timeout-ms` controls the per-round wait
(default 420000, maximum 900000); missing observations remain censored samples.

To measure the desktop activity request pattern separately:

```sh
AWS_E2E=true AWS_E2E_SHARED_SESSIONS=true AWS_E2E_REAL_CODEX=true \
  node --import tsx testing/performance-aws/controller.ts \
  --scenario 20x20 --stream-mode desktop \
  --output /absolute/path/aws-performance-desktop.json
```

The default `persistent` mode holds each SSE subscription until the scenario
finishes. `desktop` is HTTP playback of the current source's activity cadence:
one SSE request stays open across multiple activity frames, then reconnects
after EOF or the 20 s request timeout using the last cursor; cursor reset or
recovery uses a fresh snapshot and runtime read. A separate space-authority
read continues every two seconds. It does not run the native UI or reproduce every UI request and user
interaction. This mode never changes the actual client or production limits.

## Reading the artifact

The JSON file is written atomically after each phase and in final cleanup. It
includes Git revision, dirty state including untracked files, Node/platform identity, per-scenario
UTC start/end boundaries including cleanup, and monotonic phase timestamps.
Optional `--deployment-revision FULL_SHA` and `--bundle-sha256 HEX_SHA256` record
caller-supplied provenance. Independently verify these against the deployed
bundle; the controller does not claim to have done so.

- Submission-to-acknowledgement starts immediately before `fetch`, after token
  preparation, and ends at receipt of response headers. Accepted, rejected,
  network-error, and timeout outcomes remain separate.
- Peer input visibility requires the exact fixture-generated message, its
  receipt's `message_ids`, and the submitting actor's subject. Every input has
  one visibility sample per viewer. Fixture text is hashed, not persisted.
- First progress requires actual nonempty assistant text or a tool Item in a
  receipt-linked Turn absent from that round's baseline. Older output and empty
  assistant state do not qualify. Multiple receipts mapped to the same Turn are
  explicitly `shared_turn_ambiguous`; this is shared progress, not proof of which
  input caused that output. Public reasoning Items are not counted as progress.
  First-progress latency is historical first visibility: later receipt rehoming
  does not rewrite when an observer first saw output.
- Final receipt-Turn completion is a separate measurement. The controller waits
  for each accepted workload receipt to be dispatched and for every Turn in its
  current `turn_ids` mapping to be observed completed. It records latency from
  request start and from acknowledgement, using the controller's monotonic
  `performance.now()` clock; the latter is null when no acknowledgement time
  exists. Each sample retains the final receipt ID, Turn IDs, observed terminal
  status and client observation timestamp (`observedAtMs`). If a later snapshot
  rehomes a receipt, the earlier completion is invalidated and the new mapping
  must reach terminal completion. Failed receipts and Turns are reported as
  failures; deadlines and interrupted observations are censored. Neither first
  progress nor terminal completion establishes that a model answer is semantically
  correct: the one-word output is not evaluated as a per-input answer.
- Raw samples preserve timeouts, missing observations, and rejected submissions.
  Observations arriving after the round deadline remain censored. Scenario summaries
  retain the planned submission count and the count that never started after an earlier
  failure. Scenarios absent from the artifact were not run; compare the recorded options.
  Nearest-rank percentiles use observed values only; always report their counts
  and the rejected/error/censored denominators together. Small bursts cannot
  establish a stable population p99.
- Observers record every snapshot/stream/runtime/authority request's status,
  decoded body bytes, and client request-to-close occupancy, plus initial
  snapshot size. These are not TLS wire bytes or Lambda billed duration.
  Control-plane setup, submission, and manager drain polling are outside the
  observer occupancy totals and remain visible to separate server telemetry.
  Optional runtime metadata failures are retained in `auxiliaryErrors` and make
  the result fail, but do not stop activity observations. This matches the desktop's
  ability to display activity without runtime metadata. Intentional cleanup aborts
  are request outcomes, not additional backend failures.
- Final per-Turn usage includes the baseline setup Turn, marked `baseline`, and
  measured workload Turns. Usage is best effort; null means unknown, not zero.
  A failed/cancelled run may have incomplete usage. Warm/cold is unclassified
  until per-invocation platform evidence is joined externally.

The provisional submission targets are p95 <=500 ms and p99 <=1500 ms; peer
visibility targets are p95 <=1000 ms and p99 <=2000 ms. They are design targets,
not guarantees. Model first progress is a separate distribution.

Cost drivers include measured stream connection milliseconds, observer HTTP
occupancy, bytes, and model token usage. `--lambda-memory-mb 512` can record a
known configuration supplied by the deployment owner. Memory is not discovered
or verified here. USD is intentionally null. Use verified memory, Lambda REPORT
lines, API/storage metrics, provider usage, and current price provenance in a
separate cost analysis; do not multiply client occupancy into a billed-cost claim.

The controller closes all observers, waits for terminal Turns and dispatched or
failed receipts, and deletes its Sessions and Agents. Failure cleanup first
attempts cancellation and a bounded drain, then deletion even if cancellation
fails. Every identity cleanup is attempted, and uncertain cleanup is recorded.
Spaces and the disposable stack require the deployment owner's normal teardown.
Prompts, model answers, passwords, bearer tokens, raw response errors, and fixture
credentials are never written to performance artifacts.

## Focused checks

```sh
npx vitest run tests/performance-aws --no-file-parallelism
npm run typecheck
```

These checks use synthetic in-memory responses solely to test measurement and
cleanup behavior. Their results are not AWS performance measurements.
