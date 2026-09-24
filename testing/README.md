# LocalStack workflow testing

## Agents API native compatibility gate

`npm run test:agents:parity` runs the Agents suites with strict native interruption
assertions. A stock harness that rejects an interrupted child's follow-up at the
configured limit fails this gate, even when the ordinary diagnostic suite passes.
The fixture model servers are local and do not make paid model calls.

The candidate native patch and exact upstream revision are in `runtime/codex/`.
Prepare or build them in a dedicated directory with sufficient free space:

```bash
npm run codex:build -- /path/to/empty/build-directory --prepare-only
npm run codex:build -- /path/to/empty/build-directory
CODEX_CONFORMANCE_BINARY=/path/to/empty/build-directory/runtime/bin/codex npm run test:agents:parity
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

After building the worker image, exercise that exact packaged runtime as UID
10001, including programmatic tools, deferred tools, interruption and admission:

```bash
npm run test:e2e:native-image
```

This builds a disposable test layer over `rat-things-microvm-e2e:local` and runs
local model fixtures with Linux dependencies. `MICROVM_E2E_IMAGE_TAG` selects a
different worker image. The container enables namespaces for bubblewrap; native
processes remain unprivileged and receive no model credentials.

Local readiness also requires `npm run check`, `npm run smoke:local`, console
tests, LocalStack and the ARM64 image canary below. Keep unresolved behavioral
differences in `plans/agents-api-conformance.md` open until they are addressed;
this native gate does not certify all API behavior or live AWS wiring.

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
an unrelated external peer on port 8080, real public Chromium navigation, retained screenshots and
VP8 WebM recordings, and browser private-address denial, run:

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

With Terraform 1.15.8 installed, run `npm run test:infra`. Mocked AWS providers exercise
EC2-only and combined worker configurations, including S3 Files principals and MicroVM
network connector selection. These tests do not contact AWS or provision resources.
Real IAM enforcement and mount behavior remain part of the opt-in AWS canaries.

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
