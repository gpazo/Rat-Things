# Cost model

Rat Things runs the API, harness, storage and execution in your AWS account.
Model usage and AWS infrastructure are separate costs. A connected Session worker
remains available between Turns, so an idle Session can continue to incur compute
charges. Delete Sessions when their environments and harnesses are no longer needed.

## Deployment and Session costs

| Layer | Cost driver |
| --- | --- |
| Model | The requested model, reasoning, input, cached input and output tokens |
| Session worker | Dedicated EC2 instance runtime and encrypted EBS, or the selected Lambda MicroVM runtime and image storage |
| HTTP and relay | Fargate service capacity, load balancer hours and traffic, and relay distribution traffic |
| Durable state | Encrypted S3 objects, S3 Files workspace storage, DynamoDB operations and retention |
| Network | PrivateLink endpoint hours and data, optional NAT gateway and public IPv4 hours, and data transfer |
| Control and delivery | Lambda requests and duration, queues, scheduling, webhooks, logs, secrets and KMS operations |

The dedicated EC2 backend has host-managed lifetime. It is not billed only while
a model is producing tokens. EC2 charges apply until an instance stops or
terminates; see [EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).
The supplied worker shuts down after its supervisor exits, and its launch template
turns that shutdown into instance termination.

The HTTP/relay services and private-network resources can have a baseline cost
even when no Session is active. Include the [load balancer](https://aws.amazon.com/elasticloadbalancing/pricing/),
Fargate, PrivateLink, optional NAT, logs and retained storage when estimating an idle deployment.

Pi Durable inference on AWS is billed through Amazon Bedrock; local Pi uses your
ChatGPT subscription. Codex model costs depend
on the deployment's selected authentication and provider configuration. Choosing
a different runtime does not remove worker, storage, or network charges.

S3 Files is required by the dedicated EC2 Session backend and managed Pi environments.
It retains workspace bytes and Codex journals where applicable. Pi's native task
state uses the encrypted state store. Managed Pi recovery retains flushed files;
Codex workspace handoff requires a committed checkpoint. Ordinary Codex replacement
resets the workspace while retained artifacts remain available.

## Worked Session estimate

The [Terraform defaults](../infra/variables.tf) select **US West (Oregon),
`us-west-2`, and a 4096 MiB ARM Lambda MicroVM**. Its baseline is 4 GiB memory and
2 vCPUs. EC2 is an explicit alternative; its default is `m7g.large` with a 40 GiB
gp3 root disk, so use EC2 and EBS rates instead of the MicroVM rates below.

Assume one Session runs for **30 billed minutes**, including startup and idle
time, stays at baseline capacity, reads a 2 GB image once, and is then terminated
without suspending. The 2 GB image size is illustrative; substitute your actual
billable image-read size. The regional
[AWS Lambda price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-west-2/index.json)
gives these on-demand USD rates:

| Worker charge | Calculation | Cost |
| --- | --- | ---: |
| ARM CPU | 1,800 seconds × 2 vCPUs × $0.0000276944/vCPU-second | $0.0997 |
| ARM memory | 1,800 seconds × 4 GB × $0.0000036667/GB-second | $0.0264 |
| Image read on launch | 2 GB × $0.0015467699/GB | $0.0031 |
| **Worker subtotal** | Before model, state, requests and network usage | **$0.1292** |

For inference, the **Codex AWS quickstart** selects `openai.gpt-5.6-terra`.
At Bedrock Standard in-Region short-context rates, assume 20,000 uncached input
tokens and 5,000 billed output tokens, including reasoning, summed across all
model calls: `20,000 / 1,000,000 × $2.20 + 5,000 / 1,000,000 × $13.20 = $0.11`.
These rates already include Bedrock's premium. Cache use, long context and other
models change the calculation. See the
[AWS GPT-5.6 Terra pricing table](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html#model-card-openai-gpt-56-terra-pricing).
Pi has its own approved Bedrock catalog, empty by default; this example does not
imply that the quickstart model is enabled for Pi. Substitute the selected Pi
model's rates and add its S3 Files usage.

The example therefore costs **$0.2392 plus state, requests and network usage**,
before any share of the deployment baseline below. Actual image size, stored
bytes, requests and traffic are workload inputs, not known fixed Session costs.
All amounts exclude taxes, credits and negotiated discounts; recheck the linked
rates before deploying.

Disconnected or idle time is still billable while the worker runs. Another
20 minutes at this baseline adds **$0.0841** of compute. The configured MicroVM
idle timeout is 1,200 seconds, but use actual running time rather than assuming
closing the console stops billing. Resource bursts cost extra. Suspension stops
compute charges but adds snapshot writes ($0.0037977138/GB), reads on resume and
storage ($0.0001111111/GB-hour); retained images also incur storage with a one-week
minimum. See [Lambda MicroVM billing](https://aws.amazon.com/lambda/pricing/).

## Shared deployment baseline

These resources remain provisioned between Sessions. For a **730-hour month**,
the default MicroVM network has eight interface endpoints in one Availability
Zone: `8 × 730 × $0.01 = $58.40`, before data processing. The endpoint counts come
from [worker networking](../infra/modules/agent-runner/runtime-egress.tf); the
rate is in the [Oregon VPC price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/us-west-2/index.json).
Default egress rules do not create a NAT gateway. Explicitly enabling internet
routes adds NAT and public IPv4 charges.

The **optional HTTP/relay services**, disabled until their image and origin are
configured, add the following shared costs at the supplied Terraform sizes:

| Optional shared resource | Monthly calculation | Cost |
| --- | --- | ---: |
| ARM Fargate API and relay, 2.5 vCPUs and 9 GB combined | 730 × (2.5 × $0.03238/vCPU-hour + 9 × $0.00356/GB-hour) | $82.48 |
| Twelve relay interface endpoints in two AZs | 12 × 2 × 730 × $0.01/endpoint-AZ-hour | $175.20 |
| One Application Load Balancer | 730 × $0.0225/hour, before capacity units | $16.43 |
| Two task IPv4 addresses and at least two ALB IPv4 addresses | 4 × 730 × $0.005/address-hour | $14.60 |

Rates: [Oregon Fargate](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-west-2/index.json),
[Oregon VPC endpoints](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/us-west-2/index.json),
[Oregon load balancing](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/us-west-2/index.json),
and [public IPv4](https://aws.amazon.com/vpc/pricing/).
Together with the worker endpoints, these lines total approximately **$347.11/month**.
This is a subtotal: add KMS keys, image and state storage, Secrets Manager, logs,
control-plane usage, traffic and load-balancer capacity. Additional replicas,
endpoints or public addresses increase it. Deleting Sessions leaves these shared
resources in place.

For `N` Sessions, estimate `monthly shared baseline + sum of incremental Session
costs + other usage charges`. Dividing the baseline by `N` is an accounting
allocation; AWS does not charge that amount once per Session.

## Estimating a deployment

Use the selected AWS region, worker instance size, number of concurrent Sessions,
Session lifetime, stored bytes and expected model traffic in the
[AWS Pricing Calculator](https://calculator.aws/). Consult the chosen model
provider's current rates and account terms separately. Saving native checkpoints
or restoring files does not make model inference or connected worker time free.

Track model usage by Session and Turn. Track worker runtime and storage at the
private execution boundary. Keep high-cardinality owner, Session and Run IDs out
of metric dimensions; use logs and durable records for individual investigations.

## Operating controls

- Optionally configure spending alerts before AWS deployment and use allocation tags for reporting.
- Bound admitted concurrency, tool access and output sizes.
- Delete disposable Sessions and verify their workers terminate.
- Review retained artifacts, image versions, logs and stored data independently.
- Enable detailed API metrics only when their additional breakdown is useful.
- Include dedicated HTTP services and network infrastructure in idle-cost estimates.

Deleting a Session does not remove unrelated deployment infrastructure or model
credentials. Destroying a disposable deployment is a separate operation. Retained
production tables and files require an explicit retention decision.

## Optional budget alerts

AWS setup can create a monthly USD spending alert. It is disabled by default and
never required for local or AWS use. Set `--budget-usd` and `--budget-alert-emails`
in the [quickstart](quickstart.md#optional-spending-alert), or configure
[`budget_alert` in Terraform](../infra/README.md#optional-budget-alert).

The alert emails the configured recipients when actual costs reported for the
selected AWS account exceed the monthly amount. It covers all services and regions
in that account, including unrelated workloads, Bedrock inference and infrastructure.
Costs from before installation in the same month also count. Resource tags are not
required. Shared costs are not allocated to individual Rat Things owners; per-owner
admission rate limits remain a separate control.

Alerts do not stop work, shut down resources or cap charges. Billing data can arrive
late and AWS Budgets updates periodically, so notification may follow overspending.
See [AWS Budgets timing and behavior](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
Subscription fees and model charges billed directly by other providers are outside
this AWS account alert. Destroying the stack also removes its alert.
