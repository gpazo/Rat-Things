# Cost model and measured AWS spend

Rat Things keeps the control plane durable and launches isolated agent compute only for active
conversations. Operators can see the cost of each layer: model usage, MicroVM execution and
snapshots, request-scale control-plane services, and optional continuity infrastructure.

> **Current live measurement:** 27.45 seconds from a cold message to the agent runner, 1.99 seconds
> warm, and about $0.046 of non-model infrastructure for one two-turn site-generation canary. Its
> $0.380 total is a historical estimate using public rates captured on 2026-08-16, not a current
> quote. See [Two-turn publication measurement](#two-turn-publication-measurement) for the exact
> scope, breakdown, and caveats.

Agent threads, workspaces, and published files remain durable while execution scales with active
work. The result is an inspectable per-run cost with no continuously running agent worker.

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

## Two-turn publication measurement

On **2026-08-16**, one fresh API conversation created and shared a self-contained animated site,
then resumed the same suspended MicroVM to revise and republish it. This is a canary measurement,
not a concurrency benchmark. It covers message receipt through terminal orchestration and a
recipient opening the resulting share link.

| Timing | Current measurement |
| --- | ---: |
| Cold message received to agent runner | 27.45 s |
| Cold message received to successful run | 106.77 s |
| Warm message received to agent runner | 1.99 s |
| Warm message received to successful run | 24.10 s |

The cold control plane accepted the message and started the MicroVM in 3.34 seconds. AWS reported
the MicroVM started at `14:39:55.922Z`; S3 Files was mounted 23.17 seconds later and the agent runner
started 24.11 seconds after the reported VM start. On the warm turn, the dispatcher began resume at
`14:42:01.030Z` and the runner started 0.91 seconds later. The two SQS queue-delay measurements were
695 ms plus 565 ms cold and 133 ms plus 124 ms warm.

The public-list estimate captured for this exact two-turn canary on 2026-08-16 was **about $0.380**
before credits, taxes, image-build cost, or the stack's idle floor:

| Component | Estimated list cost |
| --- | ---: |
| GPT-5.6 Terra model tokens | $0.3341 |
| Lambda MicroVM active compute, 129.48 seconds | $0.0091 |
| Two snapshot reads, two writes, and six hours of suspended storage | $0.0281 |
| S3 Files access | about $0.0051 |
| NAT processing plus MicroVM-to-VPC regional transfer, 52.64 MB | about $0.0029 |
| Lambda, API Gateway, ordinary S3, and other request-scale control work | about $0.0005 |
| **Total** | **about $0.380** |

The model emitted 373,826 cumulative input tokens: 351,634 cache-read, 22,148 cache-write, and 44
uncached, plus 9,654 output tokens. The estimated non-model infrastructure portion is **$0.046**.
If the account's observed 20% effective model discount persists, the same canary is about **$0.313**
before credits.

GPT-5.6 Terra prices have changed since that measurement. The retained evidence has aggregate token
buckets across both turns, not each request's context-window classification, so recomputing a
single “current” total would imply precision the evidence does not support. Keep $0.380 as the dated
estimate and use the current short- or long-context rates below for new runs.

S3 Files access is the only provisional line because its operation-level billing records post
later. The estimate applies the observed access amplification to the durable working set. The
directly observed backing set contained **155 objects and 13.39 MB**; the high-performance-storage
minimum for that set is 14.55 MB, or about $0.0044 for a full 30-day month. The ordinary
artifact/publication path created 30 objects totaling 356 KB. A
repeat read of the unchanged output left all committed publication timestamps untouched, proving
that it minted a fresh grant without restaging the content.

Detailed API metrics contributed nothing because they were disabled. The four queue/processing
metric series fit within an otherwise unused ten-metric CloudWatch free tier. If all four were paid
for one active hour, their gross list cost would be about $0.0016; continuously active, they would
be $1.20 per month. The 14,624-byte site itself adds negligible CloudFront request and transfer cost
per view. Large videos and heavily viewed sites should model viewer egress separately.

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
record-processing duration are emitted as four low-cardinality application metric series across the
conversation coordinator and run dispatcher. The AWS account's first ten custom or detailed
metrics and first ten standard alarm metrics are covered by the CloudWatch free tier, shared across
the account.

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

The 2026-08-16 canaries received effective Cost Explorer rates about 20% below the public prices
captured then. Because that may be account-specific, capacity planning should use current public
prices unless the target account has a documented discount.

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
