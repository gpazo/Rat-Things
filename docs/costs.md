# Cost model

Rat Things keeps the control plane durable and launches isolated agent compute only for active
conversations. Operators can see the cost of each layer: model usage, MicroVM execution and
snapshots, request-scale control-plane services, and optional continuity infrastructure.

Conversation transcripts, retained files, and published files remain durable while execution
scales with active work. With S3 Files enabled, native agent-thread state and workspaces also
survive replacement compute. The result is an inspectable per-run cost with no continuously running
agent worker.

## What drives the bill

| Layer | Cost driver |
| --- | --- |
| Model | Input, cached input, output, context size, and the selected provider/model |
| Active execution | MicroVM memory, vCPU allocation, and active duration |
| Suspension | Snapshot reads, writes, size, and retained duration |
| Durable state | S3/S3 Files storage, access, requests, and retention |
| Network | Optional NAT and public IPv4 hours, processed bytes, and regional/public transfer |
| Control and delivery | API requests, queues, database operations, logs, metrics, secrets, and publication traffic |

Separate costs that grow with each Run from resources billed while the deployment is idle. Enable
billing allocation tags before deployment, and retain usage dimensions per Run so model changes,
cache behavior, and longer conversations can be priced independently.

## Per-unit prices in US West (Oregon)

These are the public rates returned by the AWS Price List for `us-west-2` on 2026-08-09. Free tiers,
credits, negotiated pricing, taxes, and later AWS price changes can alter the actual bill.

| Service part | Public unit price |
| --- | ---: |
| API Gateway HTTP API | $1.00 per million requests |
| Lambda ARM requests | $0.20 per million requests |
| Lambda ARM duration | $0.0000133334 per GB-second |
| SQS Standard | $0.40 per million requests |
| DynamoDB on-demand reads | $0.125 per million read request units |
| DynamoDB on-demand writes | $0.625 per million write request units |
| DynamoDB Standard storage | First 25 GB free, then $0.25 per GB-month |
| DynamoDB Streams reads | First 2.5 million free, then $0.20 per million |
| EventBridge custom events | $1.00 per million 64-KB events |
| S3 Standard storage | $0.023 per GB-month |
| S3 PUT, COPY, POST, or LIST | $0.005 per 1,000 requests |
| S3 GET and other requests | $0.004 per 10,000 requests |
| Secrets Manager | $0.40 per secret-month and $0.05 per 10,000 calls |
| Customer-managed KMS key | $1.00 per key-version-month |
| KMS API requests | $0.03 per 10,000 calls |
| CloudWatch Logs | $0.50 per ingested GB and $0.03 per stored GB-month |
| CloudWatch standard alarm | $0.10 per alarm-metric-month |
| CloudWatch detailed metric | $0.30 per active metric-month at the first paid tier |
| S3 Files high-performance storage | $0.30 per GB-month |
| S3 Files reads and writes | $0.03 per read GB and $0.06 per write GB |
| NAT gateway | $0.045 per hour and $0.045 per processed GB |
| Public IPv4 address | $0.005 per hour |

### Quickstart KMS deletion window

The disposable quickstart creates one customer-managed KMS key and configures Terraform's 30-day
deletion window. `destroy` schedules deletion, verifies that the exact key is disabled in
`PendingDeletion`, and records its deletion date. AWS keeps the key visible during the mandatory
waiting period, but it cannot perform cryptographic operations. AWS's current pricing page says
there is no monthly key charge while a customer-managed key is scheduled for deletion; canceling
deletion causes charges as though deletion had never been scheduled. See
[AWS KMS deletion behavior](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)
and [AWS KMS pricing](https://aws.amazon.com/kms/pricing/).

The API stage disables route-level detailed metrics by default because their cardinality grows with
the number of active routes and can cost more than API requests at low volume. Set
`enable_detailed_api_metrics=true` only when that breakdown is operationally useful. Queue delay and
record-processing duration are emitted as low-cardinality application metrics across the
conversation coordinator and run dispatcher. The runner also emits one
`CodexThreadResumeFallback` count when a missing native rollout requires durable replay into a
successor thread. Compensating cleanup emits `CleanupFailure` only after the responsible AWS SDK
exhausts its own policy. These metrics use deployment and component dimensions, never owner, Run,
or conversation IDs. The AWS account's first ten custom or detailed metrics and first ten standard
alarm metrics are covered by the CloudWatch free tier, shared across the account.

S3 Files is optional and creates the one material idle infrastructure charge in the supplied
Terraform: its dedicated NAT gateway and public IPv4 address cost about **$36 per 30-day month**
before traffic. Keep `enable_s3_files=false` for one-shot deployments that do not need native Codex
and workspace restoration across replacement MicroVMs.

Ingress into AWS is not separately charged. Public model/Git traffic still crosses both the Lambda
MicroVM VPC connector and NAT gateway. The connector can incur same-Region transfer and NAT charges
for bytes in both directions; standard internet data-transfer-out can also apply after the account
allowance. Publication viewers consume CloudFront request and egress bytes. S3 gateway endpoint
traffic does not traverse the NAT in the supplied VPC, so durable artifact synchronization does not
accidentally pay NAT processing.

## Cost of an active agent

Lambda MicroVM compute in `us-west-2` is billed at:

| MicroVM dimension | Unit price |
| --- | ---: |
| ARM memory | $0.0000036667 per GB-second |
| ARM vCPU | $0.0000276944 per vCPU-second |
| Snapshot read on launch/resume | $0.0015467699 per GB |
| Snapshot write on suspend | $0.0037977138 per GB |
| Snapshot storage | $0.0001111111 per GB-hour, equivalent to $0.08 per GB-month |

The repository defaults to 4 GB and a corresponding 2-vCPU baseline. Its compute rate is therefore
about **$0.004203 per active minute**, or **$0.06305 for 15 minutes**, before snapshot operations and
model tokens.

```text
run cost =
  $0.004203 × active runtime minutes
  + $0.0015467699 × snapshot GB read
  + $0.0037977138 × snapshot GB written
  + model tokens
  + small control-plane request charges
```

For illustration, a 15-minute run that reads a 3.4-GB launch snapshot costs about $0.068 before
model tokens. If a durable conversation also writes a 3.4-GB suspension snapshot, the total is
about $0.081 plus snapshot storage and model usage.

## Model cost is separate

Infrastructure economics do not make model inference free. As checked on **2026-08-23**, current
public in-Region GPT-5.6 Terra pricing in `us-west-2` distinguishes short and long contexts:

| Context window | Input / 1M | 30-minute cache write / 1M | Cache read / 1M | Output / 1M |
| --- | ---: | ---: | ---: | ---: |
| Short, up to 272K | $2.20 | $2.75 | $0.22 | $13.20 |
| Long, up to 1M | $4.40 | $5.50 | $0.44 | $19.80 |

Check [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) before budgeting; rates and
regional availability can change.

Use current public rates for estimates unless the target account has a documented discount.
Account credits and free-tier coverage do not remove the underlying resource cost.

## Where Rat Things fits

| Deployment model | Execution model | Isolation and continuity | Best fit |
| --- | --- | --- | --- |
| Kubernetes | Agents run as pods on cluster capacity | Cluster policy and storage integrations provide isolation and persistence | Large platforms that already operate Kubernetes and need custom scheduling |
| ECS or Fargate | Agents run as container tasks or services | Managed container lifecycle with external storage for continuity | Containerized jobs and services that fit an existing ECS platform |
| Rat Things | A dedicated MicroVM runs only while a conversation is active | Guest-kernel isolation with native suspend, resume, thread, workspace, and publication continuity | Bursty, stateful agent conversations without an agent worker fleet |

Rat Things is purpose-built for durable agent conversations. Kubernetes and ECS remain natural
choices when agents are one workload inside a broader container platform or run continuously at
high utilization.

## Cost controls before production

- Activate billing allocation tags before deployment and create a project-scoped AWS Budget.
- Keep the deterministic mock driver as the default infrastructure test path.
- Set per-owner concurrency, runtime, token, and output limits before accepting broad ingress.
- Keep detailed route metrics opt-in and avoid run, conversation, owner, or message IDs as metric
  dimensions.
- Disable S3 Files when native replacement-VM continuity is not required.
- Delete unused MicroVM image versions, remembering the one-week minimum storage charge.
- Alarm on model spend, MicroVM runtime, snapshot storage, NAT hours, and queue age independently.

References: [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/),
[Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
[DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/),
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/), and
[S3 Files metering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-metering.html).
