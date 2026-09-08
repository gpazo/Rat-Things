# How much does it cost to run an isolated AI agent in AWS?

The cost of a self-hosted agent has four main parts: model usage, active compute, durable state,
and the control plane. Workload costs grow with tokens, execution time, and retained bytes. Fixed
costs come from resources that remain provisioned between Runs, such as the optional S3 Files
network path. Estimate these separately before comparing deployment choices.

## Decide whether you need the fixed-cost path

In the supplied Terraform, `enable_s3_files=true` creates a dedicated NAT gateway so a replacement
MicroVM can restore native Codex state and exact workspace bytes. AWS currently lists a common NAT
gateway rate of $0.045 per hour and public IPv4 at $0.005 per hour; 720 hours makes that combination
about $36 before data processing. Region, taxes, negotiated rates, and future pricing can differ.

Keep S3 Files disabled for a one-shot deployment that needs durable requests, results, and ordinary
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

Apply provider and AWS rates for the intended region and billing period to those workload dimensions.

## Control model usage

Model cost depends on both the selected model and how much context each turn sends. Useful controls
include:

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

For a small deployment, omit OAuth Connections, schedules, public sharing, and VPC/NAT when they are not
needed. Set explicit retention, log, concurrency, and timeout limits. Tag every deployment and keep
development stacks disposable.

The quickstart's KMS key enters AWS's mandatory delayed-deletion state after teardown; the project
distinguishes that tombstone from a live stack rather than claiming the resource vanishes
immediately.

## Current boundaries

Include engineering time, security review, on-call work, and provider application administration
alongside the service bill. Account-specific credits are not intrinsic product economics. Rat Things
has no sustained-load cost guarantee; per-owner budgets and rate controls remain incomplete. See
[cost controls](../docs/costs.md#cost-controls-before-production) and the
[current boundaries](../docs/status-and-roadmap.md#known-gaps).

## A useful decision rule

Use the self-hosted path when owning the AWS, identity, credential, networking, and data boundary is
worth the fixed platform and operational burden. If a managed service satisfies those requirements,
compare its complete price and policy boundary against the same workload and retention assumptions.

## Sources

- [AWS Lambda MicroVM compute and snapshot pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon VPC NAT gateway and public IPv4 pricing](https://aws.amazon.com/vpc/pricing/)
- [Amazon Bedrock GPT-5.6 Terra model details and token pricing](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html)
- [Rat Things cost model](../docs/costs.md)
- [Rat Things architecture decision guide](self-hosted-vs-managed-cloud-agents.md)
