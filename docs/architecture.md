# Architecture

Rat Things implements the OpenAI Agents API in infrastructure you own. The API,
agent harness, Session coordination, encrypted storage, execution environments
and executor relay run in your AWS account. Model requests use your configured
provider. The [Agents API guide](agents-api.md) explains the public resource model
and deployment transports.

## Request to result

<figure class="doc-visual">
  <a href="durable-execution.svg"><img src="durable-execution.svg" alt="Session input is saved before outbox dispatch; a private harness executes Turns, journals evidence and delivers saved output." /></a>
  <figcaption><strong>Durable Session execution.</strong> Input, execution and result delivery have separate durable boundaries.</figcaption>
</figure>

The API authenticates the caller before deriving an owner. Session creation
snapshots the Agent configuration and resolves its environment. Input receipts,
Turn transitions and pending outbox operations are committed before asynchronous
work is dispatched. Retries use the saved occurrence and operation identities.
Deleting a Session fences later input and closes its harness.

`RunSessionExecution` translates Session work into a private execution request.
A private Run identifies a harness launch and its worker generation; it is not
another public resource or a synonym for a Turn. One live harness can execute
several Turns. Further input reaches that harness through authenticated private
control, and its runtime journal saves Items, Turns and native checkpoint state.

Input during an active Turn steers that Turn. Canceling a Turn keeps the Session;
deleting the Session closes its runtime. Function results must match an outstanding
call and Turn. SSE observes live state; saved Items and Turns provide durable
history after disconnects.

## Code boundaries and effects

| Layer | Responsibility |
| --- | --- |
| `src/domain` | Resource contracts, validation, identity and state transitions |
| `src/core` | Session, Turn, environment, Vault, schedule and outbox services against ports |
| `src/identity` | Distinct actor, owner, source, destination and credential subject |
| `src/ingress` | Provider authentication and normalization behind ingress ports |
| `src/delivery` | Destination resolution, saved Turn delivery and outcome fencing |
| `src/credentials` | Host secret-reader contracts and credential parsing |
| `src/execution` | Private dispatch, executor registry and liveness reconciliation |
| `src/plugins` | Trusted provider manifests, connection lifecycle and grants |
| `src/adapters` | AWS storage, queues, scheduling and MicroVM implementations |
| `src/app` | Composition and translation between Session and private execution ports |
| `src/lambdas` | Transport adapters and scheduled/event handlers |
| `src/runner` | Trusted harness orchestration and isolated child execution |

Planning functions transform supplied values into decisions. Services obtain
clock values, read storage, perform conditional writes and invoke external
operations. For example, recovery planning receives a stored execution and a
timestamp; the reconciler sends the resulting message. Keeping effects explicit
preserves the order in which acceptance, dispatch and terminal evidence become
durable.

## Compute and environments

The dispatcher conditionally claims a queued execution before launching a Lambda
MicroVM with a stable client token. The launch payload contains resource references
and bounded configuration; prompts and credentials remain outside it. Individual
workers are transient executions, not Terraform-managed instances.

The root lifecycle server controls mounts and process supervision. Trusted runner
code uses narrowly scoped AWS access. Agent processes run under a separate non-root
UID with a sanitized environment. A guest network policy prevents that UID from
calling the root lifecycle/control listener. External control requires an
AWS-issued, port-scoped proxy token.

The native Codex App Server hosts the Session. An environment supplies its command
and filesystem context:

- `none` supplies no command environment.
- `openai_hosted` uses the upstream wire name for a managed environment provisioned
  by Rat Things in your AWS account.
- `self_hosted` connects your prepared executor to the relay in your AWS account;
  the harness and Session storage remain yours as well.

Managed environments use `/workspace`, declared tools, prepared capabilities and
network policy. Session workers capture `/workspace/outputs` as immutable artifacts
when a Turn finishes. Local execution retains its private artifact workflow.

## Durable state

DynamoDB stores owned resource indexes, conditional state, outbox references and
bounded summaries. Complete definitions, input, runtime snapshots and file content
live in encrypted S3. Secret values live in Secrets Manager; stored records contain
references. The [durability guide](conversations.md) explains Session recovery.

Optional S3 Files storage preserves native Codex journals across replacement workers.
SQLite databases use a worker-local bind mount so concurrent agents do not share
database locks through the network filesystem. A replacement worker rebuilds those
databases while resuming the durable native thread.
Hosted sandbox replacement clears the old workspace and reapplies declared inputs;
conversation recovery uses the native checkpoint or saved Items. Its directory key
hashes the owner and Session ID together. Native thread identity comes from the
Session runtime journal. The filesystem's historical
Terraform resource names and `/conversations` access-point root stay unchanged so
existing Session state remains reachable; they do not imply a second coordination
service.

Retired Thing, Routine and conversation tables and queues remain isolated in
`infra/modules/agent-runner/retired-data.tf` pending explicit data disposition.
Existing retention and TTL policies still apply. No application role accesses
those resources. Retained conversation execution records cannot dispatch or be
requeued by the new runtime.

## Recovery and delivery

Queue messages are wake-up hints. Durable records determine whether work is
still pending. A missed Session outbox send can be repaired from pending state;
a missed private execution enqueue is repaired using the same Run ID. Duplicate
wake-ups cannot create an independent execution identity.

Workers heartbeat only while the Run ID, worker ID, generation and running
status match. The reconciler combines AWS state with a root-supervised worker
health check. It records ambiguous identity and can quarantine repeated uncertainty.
Read-only probes continue so a later confirmed termination can settle the Run.
It never treats uncertainty as permission to terminate another worker. Confirmed
loss can finish cancellation or record an execution failure; reconciliation does
not blindly replay an agent's external side effects.

Signed provider input resolves an owned Agent/environment binding and durable
Session input receipt. Schedules reserve occurrences before dispatch and retain
overlap policy. Provider notification is a separate outbox operation based on a
saved terminal root Turn. Delivery fences distinguish confirmed success,
retryable rejection and an uncertain external outcome. Harness exit does not send
a second notification for Session work.

Private execution state changes also flow through DynamoDB Streams and EventBridge
for operational consumers. Stream and notification failures have bounded retries
and retained failure queues. These mechanisms do not constitute public Session
history.

## Authority

Actor attribution, resource ownership, input source, output destination and
credential subject remain distinct. Provider signatures are checked before payload
parsing. Repository URLs use HTTPS and an allowlisted host. A notification
connection does not grant the Agent access to that provider.

Execution admits a fixed capability envelope. Agent configuration, declared tools,
IAM, network policy, provider scopes and connection grants constrain it. Host
brokers check operation and resource authority before reading a credential. There
is no pending human-approval state: an unexpected approval-shaped Codex request
fails closed. See [security](security.md) and [capability boundaries](capability-envelope.md).

The installed API remains an engineering preview. SDK type and route alignment
alone do not establish complete behavioral compatibility or deployed AWS recovery
coverage. Keep provisioning and model calls explicit when validating deployment
behavior.

## Persistent worker isolation

Dedicated ARM64 EC2 workers are available through `enable_ec2_worker` for Sessions
that must retain a live harness beyond the Lambda MicroVM lifetime. Each Session
gets one instance with a pinned AMI and container image, encrypted disk, a private
subnet and no inbound security-group rules. The root supervisor receives commands
through the encrypted AWS storage mailbox and forwards fixed operations to its
loopback control listener. A conditional claim precedes execution; an ambiguous
command is never automatically replayed.

The trusted runner reads credentials and commits Session state as root. It starts
Codex and repository commands as UID 10001. That identity cannot reach the control
listener or EC2 instance metadata, and cannot read the root supervisor's process
environment. The EC2 harness has no absolute execution timer; Session closure,
execution authority loss or host loss ends it. Conditional heartbeats renew private
Run retention while the harness remains active. MicroVM workers retain the AWS
maximum lifetime and remain available during the backend transition.
