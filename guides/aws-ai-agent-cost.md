# How much does it cost to run an isolated AI agent in AWS?

The cost of a self-hosted AI agent has four main parts: model usage, active compute, durable state,
and the always-available control plane. Keep variable workload cost separate from fixed deployment
cost. Rat Things' measured two-turn AWS canary was about **$0.380**—roughly **$0.334** for GPT-5.6
Terra model tokens on Amazon Bedrock and **$0.046** for non-model infrastructure—but enabling its
optional S3 Files network path adds about **$36 per 30-day month** for one NAT gateway and public
IPv4 address before traffic. The model amount is a historical calculation; use AWS's current
[GPT-5.6 Terra model card and token rates](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html)
for a new estimate.

> **Short answer:** budget both numbers: the dated marginal task estimate and the architecture's
> monthly idle floor. The $0.380 workload is not a current quote or a general per-task rate, and the
> $36 S3 Files floor is avoidable when replacement-worker workspace continuity is unnecessary.

## Decide whether you need the fixed-cost path

In the supplied Terraform, `enable_s3_files=true` creates a dedicated NAT gateway so a replacement
MicroVM can restore native Codex state and exact workspace bytes. AWS currently lists a common NAT
gateway rate of $0.045 per hour and public IPv4 at $0.005 per hour; 720 hours makes that combination
about $36 before data processing. Region, taxes, negotiated rates, and future pricing can differ.

Keep S3 Files disabled for a one-shot proof that needs durable requests, results, and ordinary
artifacts but not exact replacement-worker state. Enable it when that continuity is worth the fixed
networking cost. This architectural decision usually matters more than optimizing a few
request-scale control-plane calls.

## Break the bill into layers

| Layer | Typical cost drivers | How to measure it |
| --- | --- | --- |
| Model | Input, cached input, output, model choice, context length | Provider usage records per Run |
| Isolated compute | Memory size and active seconds | MicroVM and Lambda execution records |
| Suspended state | Snapshot reads, writes, retained duration | Snapshot inventory and billing data |
| Durable files | Stored bytes, access amplification, requests, retention | S3 and S3 Files metrics plus object inventory |
| Networking | NAT processing, public IPv4, regional transfer, egress | VPC flow and billing dimensions |
| Control plane | API Gateway, DynamoDB, SQS, EventBridge, logs, KMS | Tagged request-scale resources |
| Connected services | Provider API plans and rate limits | Provider billing and operation ledger |
| Model-independent idle floor | NAT, endpoints, secrets, logs, DNS, optional delivery | Cost Explorer by deployment tags |

Do not collapse these into one “agent price.” Model cost scales primarily with tokens, active
compute with time and memory, snapshots with state size and churn, and control-plane resources with
both requests and the deployed architecture.

## Read the measured Rat Things example correctly

On August 16, 2026, one fresh API conversation created and shared a self-contained animated site,
then resumed the same suspended MicroVM to revise and republish it. The measured timings were:

| Timing | Measurement |
| --- | ---: |
| Cold message received to agent runner | 27.45 seconds |
| Cold message received to successful Run | 106.77 seconds |
| Warm message received to agent runner | 1.99 seconds |
| Warm message received to successful revision | 24.10 seconds |

The captured public-list estimate for that exact two-turn canary was:

| Component | Dated estimate |
| --- | ---: |
| Model tokens | $0.3341 |
| Active Lambda MicroVM compute | $0.0091 |
| Snapshot reads, writes, and six hours of suspended storage | $0.0281 |
| S3 Files access | about $0.0051 |
| NAT processing and regional transfer | about $0.0029 |
| Request-scale control work | about $0.0005 |
| **Total** | **about $0.380** |

The model emitted 373,826 cumulative input tokens, most of them cache reads, plus 9,654 output
tokens. The retained evidence does not split every request into enough context-window pricing
buckets to recompute an honest “current” model total after prices changed. Keep this as a dated
workload measurement. The underlying methodology and caveats are in [the two-turn publication
measurement](../docs/costs.md#two-turn-publication-measurement).

## Estimate your own workload

Start with a representative unit such as one pull-request review, one scheduled digest, or one
Slack-to-Linear handoff. Record:

```text
monthly cost ≈
  runs × model cost per run
  + active MicroVM seconds × compute rate
  + snapshot operations and retained GiB-hours
  + durable filesystem and object requests
  + network processing and transfer
  + fixed monthly deployment floor
  + connected-service fees
```

Measure cold and warm paths separately. A conversation that resumes suspended compute may have a
very different start time and snapshot pattern from a new conversation. Also distinguish one-shot
Runs from long-lived threads whose workspace and native model state grow over time.

Build three scenarios rather than one forecast:

- **Typical:** the median task, expected context, and ordinary retry rate.
- **Heavy:** a large repository, browser use, generated files, and a long conversation.
- **Failure:** timeout, replacement compute, retry, and retained diagnostic artifacts.

Apply current provider and AWS rates only after the workload dimensions are measured. Do not update
the date on an old benchmark and imply that its inputs were rerun.

## Control model cost first

In the measured canary, model cost was nearly seven times the non-model infrastructure estimate.
The most effective controls are therefore usually:

- choose the least expensive model that reliably completes the task;
- keep instructions and retrieved context focused;
- avoid repeatedly loading broad documentation when a narrow guide or schema is enough;
- cap output and execution time;
- reuse a durable conversation only when its accumulated context remains valuable; and
- make idempotent submission prevent duplicate semantic Runs.

Caching may reduce billed input cost, but it does not make unnecessarily large context free. Retain
provider usage dimensions per Run so a model or pricing change does not erase the baseline.

## Control infrastructure cost by architecture

Rat Things launches isolated compute only for active work and can suspend a conversation between
turns. That avoids an always-running worker fleet, but it does not eliminate an idle floor. Optional
NAT gateways, VPC endpoints, publication delivery, Secrets Manager entries, logs, and retained
files can cost money even when no agent is active.

For a narrow proof, omit OAuth Connections, schedules, public sharing, and VPC/NAT when they are not
needed. Set explicit retention, log, concurrency, and timeout limits. Tag every deployment and keep
development stacks disposable.

The quickstart's KMS key enters AWS's mandatory delayed-deletion state after teardown; the project
distinguishes that tombstone from a live stack rather than claiming the resource vanishes
immediately.

## Evidence and limitations

| Evidence field | What is established |
| --- | --- |
| Date | August 16, 2026; pricing inputs captured August 9–16, 2026 |
| Source revision | Historical canary recorded in the cost model; this guide was reviewed against `c0156cd` |
| Environment | `us-west-2`; 4-GB/2-vCPU ARM64 Lambda MicroVM baseline; S3 Files; GPT-5.6 Terra on Amazon Bedrock |
| Model/provider | GPT-5.6 Terra through Amazon Bedrock |
| Scenario | One fresh conversation created and shared a site, then resumed the same suspended MicroVM to revise and republish it |
| Result | 106.77-second cold turn, 24.10-second warm turn, $0.3341 dated model estimate, $0.046 dated non-model estimate, and about $0.380 total marginal workload estimate |
| Reproduce | Capture per-Run model usage, MicroVM time, snapshot bytes and duration, S3 Files access, network bytes, and tagged control-plane records using [the cost methodology](../docs/costs.md#two-turn-publication-measurement) |
| Evidence | [Full two-turn measurement and attribution method](../docs/costs.md#two-turn-publication-measurement) |
| Limits | Not a concurrency benchmark, production capacity plan, current price quote, or sustained-load bill. The evidence has aggregate token buckets, so it cannot honestly be repriced as a current model total. |

The canary is not a concurrency benchmark, production capacity plan, or sustained-load price. It
does not price engineering time, security review, on-call work, provider application approval, or
the opportunity cost of operating a self-hosted system. Credits and free-tier coverage in the
project's development account are not intrinsic product economics.

Rat Things is also an engineering preview. Rate limits, tenant budgets, current repricing, and
sustained-load ceilings remain incomplete or unmeasured. Review [cost controls before
production](../docs/costs.md#cost-controls-before-production) and the [current maturity
matrix](../docs/status-and-roadmap.md#current-maturity).

## A useful decision rule

Use the self-hosted path when owning the AWS, identity, credential, networking, and data boundary is
worth the fixed platform and operational burden. If a managed service satisfies those requirements,
compare its complete price and policy boundary against your measured self-hosted scenarios—not
against the $0.380 canary headline.

## Sources

- [AWS Lambda MicroVM compute and snapshot pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon VPC NAT gateway and public IPv4 pricing](https://aws.amazon.com/vpc/pricing/)
- [Amazon Bedrock GPT-5.6 Terra model details and token pricing](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html)
- [Rat Things measured cost model](../docs/costs.md)
- [Rat Things architecture decision guide](self-hosted-vs-managed-cloud-agents.md)
