# How much does it cost to run an isolated AI agent in AWS?

The cost of a self-hosted agent has four main parts: model usage, active compute, durable state,
and the control plane. Workload costs grow with tokens, execution time, and retained bytes. Fixed
costs come from resources that remain provisioned between Runs, such as HTTP services and the private network. Estimate these separately before comparing deployment choices.

## Account for connected workers and deployment capacity

A Session can keep its harness and environment connected between Turns. Include
that idle time in worker runtime. The dedicated EC2 backend requires S3 Files;
its private network, encrypted EBS and instance lifetime all contribute to cost.
The HTTP and relay services, load balancer, NAT and retained storage also remain
provisioned independently of model requests.

Estimate these resources from the actual Terraform configuration and current
regional prices. Delete disposable Sessions when their workers are no longer
needed, and verify termination separately from public Session deletion.

## Break the bill into layers

| Layer | Typical cost drivers | How to measure it |
| --- | --- | --- |
| Model | Input, cached input, output, model choice, context length | Provider usage records per Run |
| Isolated compute | EC2 instance runtime and EBS, or selected MicroVM memory and duration | Worker and AWS execution records |
| Suspended state | Snapshot reads, writes, retained duration | Snapshot inventory and billing data |
| Durable files | Stored bytes, access amplification, requests, retention | S3 and S3 Files metrics plus object inventory |
| Networking | NAT processing, public IPv4, regional transfer, egress | VPC flow and billing dimensions |
| Control plane | HTTP and relay services, load balancers, Lambda, DynamoDB, SQS, EventBridge, logs, KMS | Tagged deployment resources |
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
  + connected worker seconds × compute rate
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

Rat Things keeps connected Session workers available between Turns. Dedicated HTTP services,
load balancers, NAT gateways, publication delivery, secrets, logs and retained files also
contribute to the idle floor. Do not budget only for time spent generating model output.

For a small deployment, omit optional OAuth Connections, schedules and public sharing when they are not
needed. The dedicated EC2 Session backend still requires its private network and S3 Files. Set explicit retention, log, concurrency, and timeout limits. Tag every deployment and keep
development stacks disposable.

The quickstart's KMS key enters AWS's mandatory delayed-deletion state after teardown; the project
distinguishes that tombstone from a live stack rather than claiming the resource vanishes
immediately.

## Current boundaries

Include engineering time, security review, on-call work, and provider application administration
alongside the service bill. Account-specific credits are not intrinsic product economics. Rat Things
has no sustained-load cost guarantee; per-owner budgets and rate controls remain incomplete. See
[cost controls](../docs/costs.md#operating-controls) and the
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
