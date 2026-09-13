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
| Network | NAT gateway and public IPv4 hours, processed bytes and data transfer |
| Control and delivery | Lambda requests and duration, queues, scheduling, webhooks, logs, secrets and KMS operations |

The dedicated EC2 backend has host-managed lifetime. It is not billed only while
a model is producing tokens. EC2 charges apply until an instance stops or
terminates; see [EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).
The supplied worker shuts down after its supervisor exits, and its launch template
turns that shutdown into instance termination.

The HTTP/relay services and private-network resources can have a baseline cost
even when no Session is active. Include the [load balancer](https://aws.amazon.com/elasticloadbalancing/pricing/),
Fargate, NAT, logs and retained storage when estimating an idle deployment.
S3 Files is required by the dedicated EC2 Session backend. It also preserves
native checkpoints and workspace state for replacement workers.

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

- Set deployment budgets and allocation tags before broad use.
- Bound admitted concurrency, tool access and output sizes.
- Delete disposable Sessions and verify their workers terminate.
- Review retained artifacts, image versions, logs and retired data independently.
- Enable detailed API metrics only when their additional breakdown is useful.
- Include dedicated HTTP services and network infrastructure in idle-cost estimates.

Deleting a Session does not remove unrelated deployment infrastructure or model
credentials. Destroying a disposable deployment is a separate operation. Retained
production tables and files require an explicit retention decision.
