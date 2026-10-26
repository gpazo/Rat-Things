# Contributor verification

## Execution-command time travel

Run `npm run sim:commands -- demo --out /tmp/command-demo` for a local,
self-checking simulation and an interactive trace report. See the
[command schedule harness](time-travel/README.md) for exploration, verified
replay, inspection, branching, and minimization commands.

## Integration adapters

Use contract, simulation, LocalStack, and opt-in disposable AWS tests when adding
a trusted integration. Cover reads, autonomously admitted writes, denied
credentials and scopes, account selection, and absence of secret values in output.

The Fixture CRM adapter uses synthetic accounts with different permissions. It is
registered only when `INTEGRATION_PLUGIN_BASE_URLS` supplies a `fixture-crm` URL.
Its scenarios exercise onboarding, provider identity and scopes, multiple accounts,
permission intersection, duplicate-write handling, and secret non-disclosure without
using a customer's third-party account. Keep it out of ordinary deployments.

## Agents API native compatibility gate

`npm run test:agents:parity:host` runs the Agents suites with strict native interruption
assertions. A stock harness that rejects an interrupted child's follow-up at the
configured limit fails this gate, even when the ordinary diagnostic suite passes.
The fixture model servers are local and do not make paid model calls.
The worker-image harness runs `npm run test:agents:parity`, which also verifies
the installed Pi child at `/opt/agent-runtime/pi-child.mjs` under worker UID 10001.
That packaging check requires the image; host parity excludes only that test.

The ordered native patches and exact upstream revision are in `runtime/codex/`.
See the [Codex runtime maintenance plan](../runtime/codex/README.md) for patch
contracts, platform upgrade gates and rollback.
Prepare or build them in a dedicated directory with sufficient free space:

```bash
npm run codex:build -- /path/to/empty/build-directory --prepare-only
npm run codex:build -- /path/to/empty/build-directory
CODEX_CONFORMANCE_BINARY=/path/to/empty/build-directory/runtime/bin/codex npm run test:agents:parity:host
```

The builder never resets an existing checkout. It records the upstream commit,
patch hashes and every packaged file hash. The complete runtime preserves the
matching upstream companion host and resources. Source preparation alone is not
verification of the patch. Build the same source for the worker's Linux ARM64
baseline, then package the image inputs:

```bash
docker buildx build --platform linux/arm64 --file runtime/codex/Dockerfile \
  --output type=local,dest=.runtime/codex/linux-arm64 .
npm run package
```

The builder defaults to one Cargo job; increase `CARGO_BUILD_JOBS` only on a host
with sufficient memory. Compilation caches are disposable; retain the exported
`runtime/` and `artifact.json` together. `CODEX_RUNTIME_ARTIFACT` can select another
export directory. Packaging verifies source, patches, file digests and Linux ARM64
executables, including the code-mode host and bundled bwrap. The image has no stock
runtime fallback. `npm run package` and therefore `npm run check` require this
artifact. Run the image canary after each accepted artifact or runner change.

For an x86 Linux local worker, build the same patched source against the Amazon
Linux 2023 baseline. Keep this artifact separate from the ARM64 cloud artifact:

```bash
docker buildx build --platform linux/amd64 --file runtime/codex/Dockerfile \
  --output type=local,dest=.runtime/codex/linux-x64 .
npm run runtime:local:build
```

The local image builder selects the artifact for the connected engine's
architecture and verifies its provenance and executable headers. Lambda
packaging continues to require the ARM64 artifact. An x86 image alone does not
establish a supported isolation backend. Run the actual worker sandbox and
recovery checks before using it for agent execution.

For the opt-in Linux KVM development backend, follow the
[image preparation and acceptance instructions](local-runtime/linux-kvm/README.md).
This path uses an unsigned local image generation and is separate from the signed
macOS runtime and ARM64 cloud packaging.

After building the worker image, exercise that exact packaged runtime as UID
10001, including programmatic tools, deferred tools, interruption and admission:

```bash
npm run test:e2e:native-image
```

This builds a disposable test layer over `rat-things-microvm-e2e:local` and runs
local model fixtures with Linux dependencies. `MICROVM_E2E_IMAGE_TAG` selects a
different worker image. The container enables namespaces for bubblewrap; native
processes remain unprivileged and receive no model credentials.

Local readiness also requires `npm run check`, `npm run smoke:local`,
[native console checks](native-console/README.md), LocalStack and the ARM64 image canary below.
The native gate covers worker behavior; API compatibility and live AWS wiring require their
respective harnesses.

This harness is adapted from the historical `testing/` stack in
`indubitably-serverless` (`2504e63b`). It keeps the useful topology—Docker Compose,
dedicated Terraform, a generated environment contract, and WireMock—but provisions only the
resources owned by the extracted agent runtime.

## One-command E2E test

Prerequisites: Docker with Compose, Node.js 22.20+, npm, Git, `curl`, and `jq`.

```bash
npm run test:e2e:localstack
```

The command starts from an empty named volume, provisions LocalStack, runs the serial workflow suite,
and removes the containers and volumes. Set `LOCALSTACK_KEEP_RUNNING=true` to retain the environment
afterward.

For interactive use:

```bash
npm run localstack:up
source testing/localstack.env
npm exec -- vitest run tests/localstack/workflow.test.ts --no-file-parallelism
npm run localstack:status
npm run localstack:down
```

`testing/localstack.env` is generated from Terraform outputs and is intentionally ignored by Git.
Use `testing/localstack.env.example` as the stable contract reference.

To build and exercise the actual ARM64 MicroVM image locally, including lifecycle startup, root/host
acceptance, cgroup eBPF denial for UID 10001 through loopback and the guest interface, acceptance of
an unrelated external peer on port 8080, run:

```bash
npm run test:e2e:microvm-image
```

This Docker-gated canary is intentionally separate from `npm run check`; ordinary verification
must not build or launch a MicroVM image. When `ffprobe` is installed, the canary also rejects any
WebM/EBML diagnostic and verifies the recording is VP8 at 1280x720 and 5 fps.

To validate the expanded JSON-RPC bridge directly against the repository-pinned Codex CLI and the
device's cached ChatGPT login, run:

```bash
npm exec -- codex login status
npm run test:e2e:codex-app-server
```

This bounded canary requires the real model to invoke a host-provided dynamic tool and return the
tool's exact unpredictable marker. It does not require Docker or AWS.

## What the test proves

The LocalStack suite uses DynamoDB, S3 and Secrets Manager with the canonical
Agent/Session services. Signed GitHub and GitLab events reserve one input occurrence
under the configured binding owner. Teams activities continue an owned Session;
saved root Turns drive separate, deduplicated delivery. Schedule tests reserve
occurrences and reject stale trigger generations.

Execution and delivery use injected deterministic ports in this suite. It tests
persistence and coordination against LocalStack, not native Codex, MicroVM lifecycle
hooks, Microsoft identity or live provider delivery. The opt-in AWS canaries and
native Codex harnesses have separate prerequisites and exercise different boundaries.

## Deliberate boundary

Handlers and the mock worker run in the host Node.js process; LocalStack owns the AWS data-plane and
event-routing services. This keeps the default test usable without a paid LocalStack tier. It does
not validate API Gateway/Lambda deployment wiring, Lambda MicroVM scheduling/isolation/lifecycle,
IAM/KMS policy enforcement, or retry timing.

LocalStack currently places [API Gateway v2](https://docs.localstack.cloud/aws/services/apigateway/)
in a paid tier. Its current [official coverage data](https://github.com/localstack/localstack-docs/tree/1035ec58cdc196d79d3a26bb86d53eecdbad698a/src/data/coverage)
does not document the Lambda MicroVM APIs, so `RunMicrovm`, lifecycle hooks, managed networking, and
isolation remain live-AWS-only checks.

CI builds the native artifact on ARM64 and caches the exported runtime by source/build inputs.
The cache is saved after compilation so a later acceptance failure does not force
another cold build. Every restored runtime still passes all acceptance checks.
The pinned companion version is part of `runtime/codex/source.json`; ordinary TypeScript
dependency updates do not invalidate this native cache.
A cold build requires at least 20 GiB free for source, compilation and container layers; the
builder itself checks for 16 GiB before compiling. Standard hosted runners advertise only 14 GB
of storage, so the job removes unused preinstalled SDKs and verifies free space before setup.
If that does not provide enough space, configure the repository variable `RAT_NATIVE_RUNNER`
with an available ARM64 runner label that does. The job's 240-minute limit includes the cold
native build, repository checks and actual worker-image tests. A cached artifact still passes
source, package and checksum validation before packaging.

After the native worker image passes, CI exports `codex-linux-arm64-<commit>`
as a downloadable artifact containing `linux-arm64.tar.gz`. Extract that tarball
into an empty directory and set `CODEX_RUNTIME_ARTIFACT` to that directory, which
must contain `artifact.json` and `runtime/`. The tarball preserves executable
permissions and hidden companion resources. Packaging verifies source identity, companions and every digest
before writing Lambda archives; an export from a different source or patch is
rejected. Cache presence alone is not native image acceptance.

Host-native sandbox checks require an OS that supports the pinned Codex sandbox
profile. A process exit is a failing check, including macOS Seatbelt profile
compilation errors; it is not converted into a skip or an unrestricted launch.
Use the Linux ARM64 worker-image harness to verify the deployment runtime.
Shell configuration fixtures use non-login Bash so personal startup scripts do
not change their environment or contaminate JSON output. Install `jq` before
running the shell fixtures.

## Worker infrastructure plans

Release security checks should exercise cancellation, worker replacement, prompt
injection, malicious repositories, SSRF, cross-owner access, and real provider payloads
against the intended enforcement boundaries. Local conformance fixtures do not establish
deployed IAM, guest isolation, network policy, or provider guarantees. Keep live AWS
checks opt-in and use disposable resources.

With Terraform 1.16.6 installed (matching `.terraform-version` and CI), run
`npm run test:infra`. Mocked AWS providers exercise
EC2-only and combined worker configurations, including S3 Files principals and MicroVM
network connector selection. These tests do not contact AWS or provision resources.
Real IAM enforcement and mount behavior remain part of the opt-in AWS canaries.

## Focused AWS proofs

These tests incur AWS and model costs. Source the intended disposable deployment's
`runtime.env` and set each proof's explicit opt-ins before running it. Dedicated EC2
proofs also require `AWS_E2E_LONG_RUNNING_AGENT_ID` selecting an Agent admitted by
`AWS_E2E_EC2_SESSION_WORKLOADS_JSON`; see [backend placement](#backend-placement-in-aws-tests).

To check guest egress on a disposable default quickstart deployment, read
`.runtime/aws-quickstart/result.json`. Set `RAT_THINGS_AGENTS_API_URL` to its
`agentsApiUrl`, `AWS_REGION` to its `region`, and `AWS_E2E_CODEX_MODEL_ID` to its
`model`. If setup used a named profile, set `AWS_PROFILE` to its `profile`. Run:

```bash
AWS_E2E=true AWS_E2E_EGRESS_PROOF=true AWS_E2E_REAL_CODEX=true \
  npx vitest run tests/aws/runtime-egress.test.ts
```

The test requires `RAT_THINGS_AGENTS_API_URL`, `AWS_REGION`, and access from the
test machine to `1.1.1.1:443`. It creates an Agent, a small uploaded file, and two
hosted Sessions. The first omits the network policy and requires effective
`disabled` access. The second enables guest networking and requires verified TLS
to a private IPv4 address for the regional Bedrock runtime endpoint. Both must
fail to connect to the public numeric TCP canary. The default policy must return
an explicit socket permission error; a timeout cannot prove sandbox enforcement.
The test machine checks the public canary before and after the guest probes.
Each Turn has a 420-second deadline.

The proof requires the exact managed command, guest UID, uploaded file and source
hashes, and an artifact that remains unchanged after its live workspace file is
overwritten. It does not require S3 Files mounts. It writes bounded receipts and
resource IDs to `test-results/aws-hardening-validation/`, then deletes its Sessions,
Agent, and upload even on failure. Run it explicitly after deployment; the default
quickstart does not run these canaries.

The hosted credential proof uses the existing deployment-owned integration fixture.
After deploying the candidate and loading its runtime environment, set
`AWS_E2E_CREDENTIAL_PROOF=true` with `AWS_E2E=true` and `AWS_E2E_REAL_CODEX=true`,
then run `npx vitest run tests/aws/environment-credentials.test.ts`.
It creates two disposable hosted Sessions, uses the fixture's synthetic alpha/beta
credentials to verify rotation and HTTPS substitution, checks guest UID/key isolation,
and requires Session secrets to enter deletion after cleanup. It never reads
Secrets Manager values through the test client.

`AWS_E2E_WORKER_RECOVERY=true` enables the recovery cases in
`tests/aws/session-recovery.test.ts`. Set `AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID` to
the exact deployment template. Each injection verifies account, deployment, Run,
execution generation and instance tags before terminating its own fixture worker.
The missing-checkpoint case waits for termination, then uses a conditional write
to give only that disposable Session an absent native thread reference. It proves
the deployed resume failure and public-history fallback; it does not delete shared
checkpoint files or claim to simulate every possible storage-corruption mode.

`AWS_E2E_SCHEDULE_PROOF=true` enables `tests/aws/schedules.test.ts`. It creates a
one-time schedule two minutes ahead, observes the outbox-created EventBridge
schedule, requires exactly one completed canonical Session, then verifies schedule
and Session cleanup. Both `RAT_THINGS_API_URL` (administration) and
`RAT_THINGS_AGENTS_API_URL` must refer to the candidate deployment.

`AWS_E2E_MULTI_AGENT_PROOF=true` enables `tests/aws/multi-agent.test.ts`. The live
model fills capacities one and six with children waiting on long-running commands
in one hosted environment (subagents do not inherit function tools),
attempts an over-capacity spawn, then interrupts and restarts the same child three
times before requiring a completed child reply. It verifies public coordination
Items and stable child identities. Each test deletes its Session and Agent.

`AWS_E2E_MCP_PROOF=true` enables `tests/aws/mcp.test.ts`. The deployment-owned
integration fixture supplies a real HTTP MCP server and a synthetic OAuth token
endpoint. The cases cover proactive expired-token refresh, refresh after HTTP 401,
metadata, public MCP Items, secret redaction and revocation on a subsequent call.
Audit messages contain only the test proof ID and account, never credential values.
The tests remove their own Sessions, Vaults and matching audit messages.

`AWS_E2E_PROVIDER_PROOF=true` enables `tests/aws/provider-tools.test.ts`, with
`AWS_E2E=true`, `AWS_E2E_REAL_CODEX=true` and an admitted
`AWS_E2E_CODEX_MODEL_ID`. Direct, programmatic and deferred application functions
must produce a required action, accept a client-supplied opaque token, retain one
function result, and return that token. A separate declared live web-search case
requires a completed public search Item. These are real model calls against
`RAT_THINGS_AGENTS_API_URL`; each case deletes its own Session and Agent.

`AWS_E2E_PUBLIC_MCP_PROOF=true` enables `tests/aws/public-mcp.test.ts` with the
same real-model opt-ins. It calls the public OpenAI documentation MCP at
`https://developers.openai.com/mcp`, separately from the service and a restricted
hosted environment. Both cases require discovered tools, a completed public MCP
Item and a documentation URL in the answer, then delete their Session and Agent.

`AWS_E2E_FILE_BOUNDARY_PROOF=true` enables `tests/aws/file-boundaries.test.ts` with
the same real-model opt-ins. It uploads 10 MiB inline across 50 input files and
copies a 50 MiB Files API input, and creates, captures, downloads and hashes
500 MiB of output (200/200/100 MiB).
It also checks that deleting an artifact leaves its environment file intact.
Allow at least 20 minutes with `AWS_E2E_TIMEOUT_MS=1200000`; this opt-in performs
large real AWS transfers and deletes its Session and Agent afterward.

`AWS_E2E_WORKER_RETIREMENT_PROOF=true` enables
`tests/aws/worker-retirement.test.ts` on the dedicated EC2 backend. Set
`AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID` to the deployment's exact template. The
canary deliberately fails hosted setup, verifies the durable failure, and waits
for automatic instance termination before deleting the Session. If it times out,
its cleanup terminates only the instance whose deployment, template, Run and
generation match this fixture; that cleanup does not count as a passing proof.

### Focused Agents release acceptance

Against an already deployed, digest-pinned disposable AWS stack, source its saved
`runtime.env` and opt into `tests/aws/api-closeout.test.ts` with
`AWS_E2E=true AWS_E2E_REAL_CODEX=true AWS_E2E_API_CLOSEOUT_PROOF=true`.
It checks narrowed permissions, whole-batch inference denial, atomic model
updates, native tool traces, pagination and deletion. `AWS_E2E_OTLP_OUTPUT` names
a local file for a real CLI export comparison. Set
`AWS_E2E_OTLP_COLLECTOR_URL` to your own collector's `/v1/traces` endpoint to check
OTLP acceptance; retain the collector's received-span evidence as well as HTTP
success. The token renewal case advances only the client's renewal deadline; it
does not claim a fifteen-minute expiry soak.

`AWS_E2E_HEARTBEAT_EXPIRY_PROOF=true` opts into
`tests/aws/heartbeat-expiry.test.ts`. It requires the dedicated EC2 backend and
saved deployment/template inputs. After its disposable Session completes a Turn,
it verifies worker deployment, Run and generation tags, conditionally ages only
that Run's durable heartbeat, and invokes the deployed reconciler. The proof
requires the specific expiry error and automatic EC2 termination before cleanup.
A live heartbeat may defeat the injection; bounded retries preserve that race
fence. This is a fault-injection proof of the one-hour decision through AWS, not
an hour of wall-clock inactivity. Failed proofs may terminate their verified
fixture worker during cleanup, which is logged separately from acceptance.

### Backend placement in AWS tests

Ordinary Sessions use MicroVM even when EC2 is provisioned. For an EC2 process soak,
create a dedicated saved Agent and set `AWS_E2E_EC2_SESSION_WORKLOADS_JSON` to its exact
owner/Agent pair before applying the test deployment, for example
`[{"owner_id":"your-api-owner-id","agent_id":"agent_long_running"}]`. Keep MicroVM enabled
for the ordinary suite. Set `AWS_E2E_LONG_RUNNING_AGENT_ID` to that Agent ID when running
`tests/aws/managed-session.test.ts`. The fixture deletes its disposable Session but keeps
the supplied Agent. The Agent must have the intended model and command-execution instructions.
A soak of 28,000 seconds or more requires this explicit Agent selection and EC2 opt-in;
merely enabling EC2 no longer selects it. Never run a long soak to test automatic migration:
no such migration exists.

### MicroVM suspension proof

Against a disposable candidate stack, source its `runtime.env` and run
`AWS_E2E_SUSPENSION_PROOF=true npm exec -- vitest run tests/aws/session-suspension.test.ts --no-file-parallelism`.
It also requires `AWS_E2E=true`, `AWS_E2E_REAL_CODEX=true` and
`AWS_E2E_ENABLE_MICROVM=true`. The test verifies the caller account, deployment execution role,
Session, Run and generation before suspending its own MicroVM or aging its heartbeat. It requires
four deployed reconciliations to retain the suspended state, then checks fresh resume evidence,
a second completed Turn, preserved workspace content and an unchanged native thread. It then
suspends again and verifies Session deletion releases the worker. It deletes its Agent; fallback termination is logged separately from successful cleanup.

This is an explicit native-suspension and stale-heartbeat fault-injection proof. It does not
measure the idle-policy timer or claim an hour-long suspension soak. Normal tests skip it.

### Workspace handoff storage proof

Run `tests/aws/workspace-handoff.test.ts` with `AWS_E2E=true`,
`AWS_E2E_CHECKPOINT_FOUNDATION=true`, `AWS_E2E_CALLER_ACCOUNT` set to the expected account,
and `AWS_REGION` set to a region other than `us-east-1`. This proof creates its own tagged
DynamoDB table and encrypted, public-access-blocked S3 bucket; it needs no running stack or
MicroVM. It races four adoption claims, checks that exactly one succeeds, verifies owner and
generation fencing, and checks atomic snapshot-record publication and independence from the
source record. It deletes both resources and saves cleanup evidence under `.aws-e2e/`.

This validates the storage foundation only. It does not run native checkpoint shutdown,
copy workspace bytes into a snapshot, or replace a real worker.

The separate worker proof requires a disposable deployment with
`TF_VAR_session_checkpoints_enabled=true` and the matching native artifact. With its generated
runtime environment loaded, run:

```bash
AWS_E2E_CHECKPOINT_WORKER=true npx vitest run tests/aws/session-checkpoint.test.ts --maxWorkers=1
```

The proof checkpoints and replaces the actual worker twice. It checks native thread identity,
conversation-only context, modified declared inputs, setup execution count, sandbox identity and
reset count. It then terminates only the fixture's worker without checkpointing to verify that a
consumed handoff recovers through the ordinary reset path. The explicit AWS, MicroVM and model
opt-ins remain required. Destroy the disposable stack after the proof.

The fork proof uses the same checkpoint-enabled disposable deployment:

```bash
AWS_E2E_SESSION_FORK=true npx vitest run tests/aws/session-fork.test.ts --maxWorkers=1
```

It creates three branches from one prepared workspace, checks conversation context and file
isolation, verifies setup ran only once, resumes the source, and replaces a child after source
deletion. The harness terminates only its own workers. Source mutations may return `409` until
snapshot publication releases the source. Destroy the disposable deployment afterward.

For an interactive two-theme fork workflow, including a no-cloud walkthrough and an
explicit live mode, see [the Fork studio harness](fork-demo/README.md). Browser checks
run with the website suite; live validation remains an opt-in operation.

The native image parity gate also runs `tests/pi`. It exercises the packaged
non-root Pi child and the managed execution broker without model credentials.
The LocalStack entrypoint runs all of `tests/localstack`, including native Pi
S3/DynamoDB commit acknowledgement and ownership fencing tests. CI runs this
entrypoint explicitly; neither suite provisions live AWS resources.
