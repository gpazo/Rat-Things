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

## What the test proves

The suite first verifies that correctly signed GitHub and GitLab events are normalized into the
canonical S3, DynamoDB, and SQS contract. Its full deterministic execution path is:

```text
signed Teams webhook
  -> Secrets Manager verification
  -> S3 input + DynamoDB run + SQS wake-up
  -> dispatcher with a test-only ECS launch reference
  -> real worker with the mock agent driver
  -> S3 output/events + DynamoDB terminal state
  -> actual DynamoDB Streams records
  -> state-stream handler -> EventBridge -> capture SQS
  -> notifier -> WireMock Teams Workflow endpoint
```

The suite also verifies webhook idempotency, the stored artifacts, execution attachment, the
EventBridge envelope, the durable delivery fence, exact Adaptive Card content, and duplicate egress
suppression.

## Deliberate boundary

Handlers and the mock worker run in the host Node.js process; LocalStack owns the AWS data-plane and
event-routing services. This keeps the default test usable without a paid LocalStack tier. It does
not validate API Gateway/Lambda deployment wiring, Fargate scheduling and isolation, IAM/KMS policy
enforcement, or retry timing.

LocalStack currently places [API Gateway v2](https://docs.localstack.cloud/aws/services/apigateway/)
and [ECS `RunTask`](https://docs.localstack.cloud/aws/services/ecs/) in paid tiers. A paid-tier
extension can later deploy the packaged Lambdas and worker image to exercise that functional path.
LocalStack's current [official coverage data](https://github.com/localstack/localstack-docs/tree/1035ec58cdc196d79d3a26bb86d53eecdbad698a/src/data/coverage)
does not document the Lambda MicroVM APIs, so `RunMicrovm`, lifecycle hooks, image/connectors, and
isolation remain AWS-only canaries.
