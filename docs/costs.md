# Cost model and measured AWS spend

Rat Things is designed to pay for isolated agent execution while work is active instead of keeping
an agent computer online between requests. The durable control plane remains available, but agent
compute launches, resumes, suspends, or terminates with the conversation.

This makes Rat Things economically different from an always-on VPS, EC2 instance, or dedicated
desktop. Those can be sensible for steady, trusted, single-tenant workloads. For intermittent or
untrusted agent work, however, they charge for idle capacity and leave host lifecycle, isolation,
patching, credential residency, and concurrency with the operator.

## Measured build and test spend

As of **2026-08-09**, the project's live-AWS development and validation produced:

- about **$1.27 of gross attributable AWS usage**;
- about **$1.07 of AWS credits and free-tier coverage**; and
- about **$0.20 net account cost**.

The measured work included eight disposable stack lifecycles, seven MicroVM images, thirteen image
version builds, signed ingress-to-delivery tests, same-VM suspend/resume, replacement-VM workspace
and Codex-thread restoration, failure-recovery exercises, and bounded GPT-5.6 Terra canaries.

| Component | Gross measured cost |
| --- | ---: |
| Lambda MicroVM compute and snapshots | $1.02501 |
| GPT-5.6 Terra on Amazon Bedrock | $0.19928 |
| S3 requests and storage | $0.01761 |
| Secrets Manager | $0.01277 |
| KMS | $0.00672 |
| Earlier ECS/Fargate parity test | $0.00316 |
| EventBridge | $0.00128 |
| API Gateway | $0.00096 |
| **Total gross attributable usage** | **$1.26680** |
| **Net after account credits** | **about $0.19928** |

Standard Lambda, DynamoDB, SQS, CloudWatch, NAT, public IPv4, and S3 Files activity was priced to
zero by the account's credits or free-tier plan during these tests. Those services are not
intrinsically free; their normal unit prices are listed below.

AWS applies a one-week minimum retention period to Lambda MicroVM image snapshot storage. All test
images were deleted, but roughly $0.07–$0.08 of additional gross storage usage may post while the
minimum ages out. That expected tail is not included in the $1.27 figure.

### Attribution method and limitations

The measured legacy resources carried `Project=indubitably-agent`; current stacks use
`Project=rat-things`. Both include `DeploymentId` and `Ephemeral=true`
tags, but `Project` was not activated as an AWS billing cost-allocation tag before the tests. The
total was therefore reconstructed from:

- local Terraform state and teardown timestamps;
- CloudTrail create/update/delete events;
- unique `us-west-2` Cost Explorer service, operation, and usage-type records; and
- public AWS Price List unit rates.

The dominant MicroVM and Bedrock records are unambiguous. Allow a few cents of uncertainty in the
small shared-account service lines. Production accounts should activate the project, environment,
owner, and deployment tags before the first deployment and enforce them with account policy.

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

The API stage currently enables route-level detailed metrics. Their cardinality grows with the
number of active routes, so they can cost more than API requests at low volume. The AWS account's
first ten custom or detailed metrics and first ten standard alarm metrics are covered by the
CloudWatch free tier, shared across the account.

S3 Files is optional and creates the one material idle infrastructure charge in the supplied
Terraform: its dedicated NAT gateway and public IPv4 address cost about **$36 per 30-day month**
before traffic. Keep `enable_s3_files=false` for one-shot deployments that do not need native Codex
and workspace restoration across replacement MicroVMs.

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

Infrastructure economics do not make model inference free. Current public GPT-5.6 Terra pricing in
`us-west-2` is $2.75 per million input tokens, $3.44 per million 30-minute cache-write tokens, $0.28
per million cache-read tokens, and $16.50 per million output tokens.

The measured canaries received effective Cost Explorer rates about 20% below those public prices.
Because that may be account-specific, capacity planning should use public prices unless the target
account has a documented discount.

## Comparing deployment models

| Deployment model | Idle cost | Isolation and lifecycle | Best fit |
| --- | --- | --- | --- |
| Always-on VPS or VM | Host is billed while waiting | Operator patches, fences, monitors, and replaces the host | Steady trusted workload with consistently high utilization |
| Dedicated desktop or Mac mini | Hardware, power, network, and operator time remain committed | Physical ownership; remote access and multi-agent isolation remain operator concerns | Trusted personal workstation or fixed local automation |
| Rat Things MicroVM | No agent compute while no MicroVM is running | Dedicated guest per active conversation; AWS owns VM provisioning and teardown | Bursty, isolated, multi-conversation agent execution |

This is not a claim that serverless is always cheaper. Sustained high utilization can favor reserved
or owned capacity, and S3 Files' NAT gateway creates an idle floor. Rat Things is optimized for the
case where agent demand is intermittent, isolation matters, and idle machines are the wrong unit of
scale.

## Cost controls before production

- Activate billing allocation tags before deployment and create a project-scoped AWS Budget.
- Keep the deterministic mock driver as the default infrastructure test path.
- Set per-owner concurrency, runtime, token, and output limits before accepting broad ingress.
- Keep detailed route metrics only where their operational value justifies their cardinality.
- Disable S3 Files when native replacement-VM continuity is not required.
- Delete unused MicroVM image versions, remembering the one-week minimum storage charge.
- Alarm on model spend, MicroVM runtime, snapshot storage, NAT hours, and queue age independently.

References: [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/),
[Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
[DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/),
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/), and
[S3 Files metering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-metering.html).
