# LocalStack workflow testing

This harness is adapted from the historical `testing/` stack in
`indubitably-serverless` (`2504e63b`). It keeps the useful topology—Docker Compose,
dedicated Terraform, a generated environment contract, and WireMock—but provisions only the
resources owned by the extracted agent runtime.

## One-command E2E test

Prerequisites: Docker with Compose, Node.js 20+, npm, Git, `curl`, and `jq`.

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

## Real Codex Teams chat slice

After signing in with the repository's pinned Codex CLI, run:

```bash
npm exec -- codex login
npm run test:e2e:teams:codex
```

This opt-in test uses the local ChatGPT subscription instead of the mock driver. It submits a signed
Teams-shaped `@Rat Things` mention, runs the normalized prompt through real Codex, persists the
result, and captures a threaded-reply gateway request in WireMock. The assertion requires the reply
to carry the exact inbound `conversationId` and `activityId`, and the command prints the safe fixture,
Codex response, and captured outbound envelope for review. Command-tool network access remains off.

## What the test proves

The suite first verifies that correctly signed GitHub and GitLab events are normalized into the
canonical S3, DynamoDB, and SQS contract. Its full deterministic Teams path is:

```text
signed Teams webhook
  -> Secrets Manager verification
  -> S3 message + DynamoDB mailbox + conversation SQS wake-up
  -> coordinator + attached run + run SQS wake-up
  -> dispatcher with a test-only MicroVM execution reference
  -> real worker with the mock agent driver
  -> S3 output/events + DynamoDB terminal state
  -> actual DynamoDB Streams records
  -> state-stream handler -> EventBridge -> capture SQS
  -> notifier -> WireMock Teams Workflow endpoint
```

The suite also verifies webhook idempotency, the stored artifacts, execution attachment, the
EventBridge envelope, the durable delivery fence, exact Adaptive Card content, and duplicate egress
suppression.

The control-plane path first proves Fixture CRM rejects an invalid credential with no persisted
secret. It then verifies two permission-distinct provider accounts for the same owner, stores only
credential references in DynamoDB and the values in Secrets Manager, groups the accounts in one
connection set, creates a paused routine, and retries its manual run with one idempotency key. The
resulting request crosses S3, DynamoDB, SQS, the dispatcher, and the real worker with the
deterministic mock driver. This proves provider identity, permissions, and account selectors survive
the durable path without embedding tokens; the separate agent-loop simulation exercises actual
integration and browser dynamic-tool calls.

It also appends deferred and interrupting conversation messages, verifies interrupt-first GSI
ordering, fences work with a renewable lease, records progress/history, and completes the turn. A
second signed Teams activity schedules another run with the prior MicroVM and Codex thread IDs and
durably replays the earlier prompt/result. It proves idempotent webhook/message replay and rejects
conflicting reuse of a provider message ID.

The opt-in real-Codex path selects `TEAMS_DELIVERY_MODE=threaded-gateway`; the default deterministic
suite remains on the Workflow bridge. The gateway contract is the seam for a future AWS-hosted
Entra/Bot integration. WireMock proves thread addressing, not Microsoft identity or live delivery.

## Deliberate boundary

Handlers and the mock worker run in the host Node.js process; LocalStack owns the AWS data-plane and
event-routing services. This keeps the default test usable without a paid LocalStack tier. It does
not validate API Gateway/Lambda deployment wiring, Lambda MicroVM scheduling/isolation/lifecycle,
IAM/KMS policy enforcement, or retry timing.

LocalStack currently places [API Gateway v2](https://docs.localstack.cloud/aws/services/apigateway/)
in a paid tier. Its current [official coverage data](https://github.com/localstack/localstack-docs/tree/1035ec58cdc196d79d3a26bb86d53eecdbad698a/src/data/coverage)
does not document the Lambda MicroVM APIs, so `RunMicrovm`, lifecycle hooks, managed networking, and
isolation remain live-AWS-only checks.
