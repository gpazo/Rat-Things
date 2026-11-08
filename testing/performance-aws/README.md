# Shared Session AWS performance controller

This opt-in controller measures a real Cognito-authenticated shared Session and
the deployed Agents API. It creates distinct writers and viewers, uses a fixed
execution role with no tools and `environment: none`, and asks the configured
real model for one-word replies. It does not deploy infrastructure or collect
CloudWatch billing data. Ordinary tests never invoke AWS.

The controller rejects GPT-6 Astra and requires an explicitly configured
GPT-6 Luna or GPT-5.6 Luna model ID. Choose one supported by the deployment region and endpoint. Workload inputs are capped at 60, setup Session inputs at
8, controller HTTP client retries are disabled, and the prompt requests a one-word
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

The default matrix is `1x1`, `10x10`, `20x20`, and `20x50`, where the first
number is simultaneous writers and the second is viewers. Each scenario creates
its own space and shared Session.
One burst is the default. Narrow the matrix or explicitly request rounds within
the 60 workload and 8 setup input caps.
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

## Zero-inference Lambda Web Function peer progress

`progress.ts` measures accepted-input acknowledgement and exact peer receipt
visibility through two deployed Lambda Web Function revisions. It exercises the
normal OIDC create, input and SSE routes. Pass each Web Function's `/v1` URL for
`--before-url` and `--after-url`. Pass the IAM control API Gateway's `/v1` URL
for `--operator-url`, because space bootstrap is a SigV4 control operation.
Each side of every pair gets a fresh space and Session. Odd pairs run before/after;
even pairs reverse the order to reduce ordering bias.
Persistent mode uses 20 writers and 50 viewers; desktop mode uses 20 writers and
20 viewers.

The harness never invokes a model. Before starting it, verify outbox dispatch and
reconciliation are held, worker provisioning is denied, and model-provider access
is denied. Leave the Web Function request path enabled so the measurement exercises
the deployed API. The Luna model ID is required only because the API validates the
Agent's admitted execution role; no inference request is made. Each fresh Session
has one setup receipt, reported separately from measured workload inputs.

```sh
AWS_E2E_PROGRESS=true AWS_E2E_SHARED_SESSIONS=true \
  node --import tsx testing/performance-aws/progress.ts \
  --before-url https://before.lambda-web.us-west-2.on.aws/v1 \
  --after-url https://after.lambda-web.us-west-2.on.aws/v1 \
  --operator-url https://operator.execute-api.us-west-2.amazonaws.com/v1 \
  --mode both --pairs 5 --output /absolute/path/aws-peer-progress.json
```

The controller also requires `AWS_REGION`, `AWS_E2E_CODEX_MODEL_ID` (an admitted
Luna ID), and `TEAM_OIDC_FIXTURE_JSON`. It caps the run at five alternating
before/after pairs per selected mode, 20 concurrent inputs, 30 seconds of
observation per cell, and 60 minutes total. It makes no retries. The optional
`run` dependency `prepareSession` is a trusted in-process fixture hook for direct
storage setup such as older Session history; it is not a public route. Shared-space
Session import is forbidden, so do not use the public import endpoint to seed it.
Record the seeded history and keep fixture space-discovery counts equal when
reusing identities: desktop playback lists their spaces outside the Session stream.

The artifact includes submission-to-acknowledgement, exact receipt/message/actor
visibility, acknowledgement-to-peer timing, and per-viewer HTTP bytes, errors and
connection occupancy. Missing and failed observations remain explicit. Probes
check viewer write denial and revoked viewer read/write denial after measurement.
Artifact serialization runs outside the timed peer-observation window. The run does
not measure assistant progress or completion, native UI behavior, Lambda billing,
or model-provider cost. Bundle SHA-256 values can be supplied with
`--before-bundle-sha256` and `--after-bundle-sha256`; independently verify those
hashes and the deployed source revisions.

## Compare fresh Session startup

`startup.ts` measures fresh Sessions through a disposable operator Web Function.
It records request acceptance, the first API-visible assistant text, completion,
usage, and the actual image version of each worker. Use a deployment with no
other callers. The controller restores its active image-version parameter on exit.

Build test images with `startup-responses-proxy-image.mjs`. This overlay keeps the
official native Codex binary and starts a loopback Responses endpoint. Fixture mode
returns `OK` without inference. Bedrock mode forwards one request to the fixed
us-west-2 Luna endpoint, with a 64 KiB request-body limit, a 128-output-token limit,
no retries or redirects, and a 30-second forwarding deadline. These are test images;
do not deploy them for user Sessions.

```sh
node testing/performance-aws/startup-responses-proxy-image.mjs \
  /absolute/path/before-source.zip /absolute/path/before-fixture.zip --mode fixture
node testing/performance-aws/startup-responses-proxy-image.mjs \
  /absolute/path/after-source.zip /absolute/path/after-fixture.zip --mode fixture
```

Publish both overlaid ZIPs as versions of the same MicroVM image. Keep worker
resources and the managed base-image version identical. Source the disposable
stack's `runtime.env`, then install an explicit Bedrock and SageMaker inference
deny policy on its worker execution role before fixture runs.

```sh
AWS_E2E=true AWS_E2E_REAL_CODEX=true STARTUP_MODE=fixture \
  STARTUP_INFERENCE_DENIED=true \
  STARTUP_BEFORE_VERSION=2.0 STARTUP_BEFORE_SOURCE_ZIP=/absolute/path/before-fixture.zip \
  STARTUP_AFTER_VERSION=3.0 STARTUP_AFTER_SOURCE_ZIP=/absolute/path/after-fixture.zip \
  STARTUP_OUTPUT=/absolute/path/startup.json \
  node --import tsx testing/performance-aws/startup.ts
```

The controller requires `AWS_REGION=us-west-2`, `AWS_E2E_DEPLOYMENT_ID`,
`AWS_E2E_CALLER_ACCOUNT`, `RAT_THINGS_AGENTS_API_URL`, and
`AWS_E2E_CODEX_MODEL_ID=openai.gpt-5.6-luna`. It compares each deployed source
object's SHA-256 with the local ZIP, then verifies the overlay manifest and proxy
hash before creating a Session. Fixture comparisons default to five alternating
pairs. Set `STARTUP_PAIRS` from one through five for a smaller fixture run.

For one diagnostic, replace the before/after variables with
`STARTUP_DIAGNOSTIC_VERSION` and `STARTUP_DIAGNOSTIC_SOURCE_ZIP`. Do not also set
`STARTUP_PAIRS`. A diagnostic is not a comparative performance result.

Reserve Bedrock mode for a small provider integration check. Build both images
with `--mode bedrock`, verify current model availability and pricing, and remove
the fixture inference deny only for that check. Use `STARTUP_MODE=bedrock`.
Bedrock comparisons permit one pair, or one Session in diagnostic mode. Each
worker admits one request. The model's full context limit and higher long-context
prices give a conservative two-request bound below $1.20. The request byte cap
usually makes actual input far smaller, but is not a tokenizer measurement.
The controller reports provider usage and an estimate separately from synthetic
fixture usage. Infrastructure charges need separate accounting.

All runs stop on the first failure, unexpected answer, missing usage, or deadline.
Each Session has a three-minute observation deadline; the controller has thirty
minutes total. Native and proxy inference retries are disabled. SDK cleanup
DELETE requests permit two retries. Export evidence, then destroy the stack.

First output means nonempty assistant text from the standard Items and Turns
endpoints, polled concurrently with 500 ms between iterations. Startup status and
protocol bytes do not count. Keep worker logs to correlate `runner_startup_trace`,
`startup-responses-proxy`, and host storage timings. The loopback hop is test-only
and both sides must use the same overlay. Fixture results exclude real model
latency. Fresh MicroVMs do not control AWS snapshot-cache residency. Report small
real-model samples as preliminary, without fleet percentiles or cold-start bounds.

## Probe fresh S3 Files mount startup without inference

`storage.ts` launches disposable MicroVMs directly with `RunMicrovm`. It sends a
valid persistent-session lifecycle hook but does not create a Run record or call a
Session API. The runner stops at its strongly consistent lookup for the absent Run,
before it reads an artifact or starts an execution driver. The probe role must
have an explicit Bedrock inference deny, and the operator must confirm that deny
and the disposable deployment before launching.

The default plan runs five alternating baseline and candidate pairs with storage
enabled on every MicroVM. One MicroVM runs at a time. The plan makes ten launches.
AWS caps each MicroVM lifetime at 120 seconds. The controller allows a 120-second
work window and a separate 60-second cleanup window per probe, within a 30-minute
overall deadline.
`--pairs 1` through `--pairs 6` selects one through six pairs, up to twelve
launches. For one diagnostic sample,
pass `--diagnostic storage|control` and `--version baseline|candidate`. The
`control` mode omits the S3 Files fields from the hook while keeping
`persistentSession: true`. A diagnostic accepts matching baseline and candidate
version strings because it uses one version only.

The JSON configuration file contains exactly these string fields:

```json
{
  "deploymentId": "perf-demo",
  "region": "us-west-2",
  "account": "123456789012",
  "imageIdentifier": "arn:aws:lambda:us-west-2:123456789012:microvm-image:rat-things-perf-demo-agent",
  "baselineVersion": "1.0",
  "candidateVersion": "2.0",
  "executionRoleArn": "arn:aws:iam::123456789012:role/rat-things-perf-demo-microvm-execution",
  "connectorArn": "arn:aws:lambda:us-west-2:123456789012:network-connector:nc-00000000-0000-0000-0000-000000000000",
  "logGroupName": "/rat-things-perf-demo/microvms",
  "runsTableName": "rat-things-perf-demo-runs",
  "integrationsTableName": "rat-things-perf-demo-integrations",
  "artifactBucket": "rat-things-perf-demo-artifacts-000000000000",
  "filesystem": "fs-00000000000000000",
  "accesspoint": "fsap-00000000000000000",
  "targetIP": "10.0.0.7"
}
```

Replace every example value with the disposable deployment's values. The
controller checks deployment names on the image, role, log group, tables, and
artifact bucket. It checks the connector's account, region, and identifier format.
Copy the connector and filesystem identifiers from the same disposable
deployment. The controller checks the caller account with STS. Both image versions must be active successful builds
with matching base image, CPU, and resource settings.

Run the default comparison with:

```sh
AWS_E2E_STORAGE_PROBE=true \
AWS_E2E_STORAGE_PROBE_DISPOSABLE_CONFIRMED=true \
AWS_E2E_STORAGE_PROBE_MODEL_DENY_CONFIRMED=true \
node --import tsx testing/performance-aws/storage.ts \
  --config /absolute/path/storage-probe-config.json \
  --output /absolute/path/storage-probe.json
```

The diagnostic flags select exactly one launch. For example, compare the mount
path with its no-storage control on the baseline image:

```sh
AWS_E2E_STORAGE_PROBE=true \
AWS_E2E_STORAGE_PROBE_DISPOSABLE_CONFIRMED=true \
AWS_E2E_STORAGE_PROBE_MODEL_DENY_CONFIRMED=true \
node --import tsx testing/performance-aws/storage.ts \
  --config /absolute/path/storage-probe-config.json \
  --output /absolute/path/storage-control.json \
  --diagnostic control --version baseline
```

Pass `--expect-profile` only with one storage diagnostic on an image that includes
the test-only storage-mount profiling overlay. Create that diagnostic bundle with
`node testing/performance-aws/storage-profile-image.mjs <source.zip> <profile.zip>`.
The overlay adds tracing to the mount path and changes its timing. Use its output
to investigate phases, and use ordinary images for latency comparisons.
The controller then requires the matching
`rat-things.storage-mount-profile.v1` log marker and keeps only its allowlisted
fields. Every unprofiled or timed comparison rejects a profile marker so it cannot
mix traced and production image observations. Those probes need only the lifecycle
mount, runner-start, missing-Run, and runner-exit records.

Every probe reads its generated Run ID with a strongly consistent DynamoDB read
before and after the launch. It records AWS image provenance, the actual image
version returned by `GetMicrovm`, the mount and storage-preparation durations, and
the missing-Run failure. It polls a unique CloudWatch log stream and terminates
the exact MicroVM, then verifies `TERMINATED`. A launch response that is uncertain
is reconciled against the new MicroVM list; when no unique resource can be found,
the artifact fails and names any possible IDs. `RunMicrovm` and the AWS CLI calls
use one attempt. No command goes through a shell, and the artifact omits AWS
credentials and raw helper logs.

The probe measures startup through storage preparation and the runner's expected
missing-Run exit. Storage preparation creates directories and changes their
ownership. The probe does not execute user work, measure first output, or verify
durable file contents across a replacement MicroVM. CloudWatch startup fields report
`startupDurationMs`, `storageMountDurationMs`, `storagePreparationDurationMs`,
and `storageAlreadyMounted`; the optional profile reports helper timing and its
declared `mount-launcher-only` syscall scope. Do not present these results as a
first-output latency comparison or as a durability proof.

## Focused checks

```sh
npx vitest run tests/performance-aws --no-file-parallelism
python3 testing/performance-aws/test-storage-profile.py
npm run typecheck
```

These checks use synthetic inputs to test probe plans, evidence parsing, and
deadline calculations. Their results are not AWS performance measurements.
