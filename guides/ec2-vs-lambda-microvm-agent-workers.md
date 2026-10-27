# EC2 vs Lambda MicroVM workers for AI agent Sessions

Rat Things supports dedicated EC2 workers and Lambda MicroVM workers in your AWS
account. Choose EC2 when a Session needs to retain a live harness and processes
beyond the MicroVM lifetime. Choose Lambda MicroVMs when the service-managed
lifecycle fits the task. In both cases, durable Session records live outside the
worker; keeping compute alive and recovering saved work are separate guarantees.

## Compare the execution lifecycle

| Concern | Dedicated EC2 worker | Lambda MicroVM worker |
| --- | --- | --- |
| Isolation unit | One ARM64 instance per Session | Dedicated MicroVM execution |
| Live harness | No absolute Rat Things execution timer; ends on closure, authority loss or host loss | Subject to the AWS MicroVM maximum lifetime |
| Provisioning | Opt-in `enable_ec2_worker`, pinned AMI and container image | Configured MicroVM image and lifecycle service |
| Control | Encrypted storage mailbox and private loopback supervisor | AWS-issued, port-scoped proxy token for lifecycle control |
| Ingress | Private subnet with no inbound security-group rules | Service-required lifecycle port only; no user-facing ingress |
| Durable records | Encrypted S3 content and DynamoDB coordination | The same storage and coordination contracts |

These are Rat Things backend behaviors, described in
[compute and environments](../docs/architecture.md#compute-and-environments) and
[persistent worker isolation](../docs/architecture.md#persistent-worker-isolation).
Neither backend is a shared machine exposed directly to users.

## Plan recovery separately

A connected worker can preserve processes between Turns. Replacement cannot
recreate sockets or arbitrary process memory. Codex conversation restoration and
workspace restoration have separate rules. With S3 Files and Session checkpoints,
a clean idle handoff can save workspace and native state for a compatible successor.
Pi Durable managed recovery requires those storage and checkpoint capabilities.

External writes need their own receipts and reconciliation. A replacement worker
must not repeat an uncertain operation just because the old process disappeared.
See [durable AI agent state](durable-ai-agent-state.md).

## Current boundaries

This comparison describes the backends integrated into Rat Things, not every
EC2 configuration or Lambda product. Both cloud worker images are Linux ARM64.
EC2 still requires capacity, image maintenance and lifecycle operations. MicroVM
availability and limits depend on the AWS service and deployment. Neither backend
provides unlimited lifetime or automatic recovery of every interrupted task.

## Frequently asked questions

### Does a durable Session need an EC2 worker that never stops?

No. A Session stores accepted input, observed results and recovery state outside
its worker. EC2 helps retain a live harness for longer work, but stored state and
recovery rules determine what survives worker loss.

### Can I switch an existing Session between EC2 and Lambda MicroVMs freely?

Do not assume a backend switch migrates running work. Follow the deployment's
lifecycle and supported checkpoint handoff path. Saved files and conversation
state do not transfer live processes or sockets.

## Sources

- [Rat Things architecture](../docs/architecture.md)
- [Session durability](../docs/conversations.md#how-durability-works)
- [Runtime recovery limits](../docs/agent-runtimes.md)
- [Terraform configuration](../infra/README.md)
