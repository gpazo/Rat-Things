# Operational runbook

This runbook assumes an operator with read access to the runtime stack, CloudWatch Logs/Metrics,
DynamoDB Session/execution records, SQS, S3 metadata, and the configured MicroVM or EC2 APIs.
Use a separately audited break-glass role for mutations not exposed by the control API.

## First response

Before investigating a run, establish the exact account, Region, environment, and deployment
revision. Dev and production secrets, webhook URLs, queues, artifact buckets, roles, and source
installations must remain separate.

```bash
aws sts get-caller-identity
terraform -chdir=infra workspace show
terraform -chdir=infra output -json
npm run build
```

Set `AWS_REGION`, `RAT_THINGS_API_URL` (control) and `RAT_THINGS_AGENTS_API_URL`
(Agents) from the intended stack outputs, then inspect the Session as its owning identity:

```bash
npm run rat-things -- doctor
npm run rat-things -- sessions get SESSION_ID
npm run rat-things -- sessions turns SESSION_ID
npm run rat-things -- sessions items SESSION_ID
npm run rat-things -- sessions artifacts SESSION_ID
```

An idle Session can contain a failed Turn. Inspect the latest Turn and saved Items before
investigating its private execution Run. Provider-bound Sessions belong to the binding's
owner and are not visible to unrelated API identities. Use administrative read access to
correlate the provider occurrence, input receipt, Session and private Run; never weaken
ownership or enable `ALLOW_OWNER_HEADER` in a deployed environment.

Record this evidence before changing anything:

- Session and Turn IDs, owner, input receipt, required actions, status and bounded error;
- private Run ID, status, timestamps, execution ID and generation;
- API Gateway request ID or provider delivery/activity ID;
- SQS message receive count and DLQ presence;
- Agents outbox, dispatcher, worker and delivery log timestamps;
- backend state and termination reason;
- provider delivery receipt/fence status and any applicable terminal event; and
- deployment/image revision plus any active AWS/provider incident.

Do not paste prompts, repository contents, presigned URLs, headers, secret values, or full model event
streams into tickets or chat.

## Health and service map

`GET /health` checks only that API Gateway can invoke the control Lambda. It does not check DynamoDB,
S3, SQS, MicroVMs, model access, repository access, or notification providers.

Expected log-group naming for a stack named `<prefix>-<environment>` is:

```text
/aws/lambda/<name>-control
/aws/lambda/<name>-agents-api
/aws/lambda/<name>-agents-outbox
/aws/lambda/<name>-dispatcher
/aws/lambda/<name>-reconciler
/aws/lambda/<name>-thing-schedule
/aws/lambda/<name>-state-stream
/aws/lambda/<name>-notifier
/aws/lambda/<name>-webhook-<provider>
/<name>/api
/<name>/microvms
```

Use Terraform outputs/resource tags instead of guessing physical names.

## Session input and execution triage

For input that never starts, inspect the durable receipt, `session_integrations` entry
for provider input, Agents table stream, FIFO queue and `agents-outbox` logs. Confirm
that the saved Agent, environment template and Vaults belong to the binding owner.
Inspect the Agents failure queue before redriving work. A Session waiting for an
application function result needs the matching result, not another input message.

The statuses below belong to private execution Runs, not public Turns. Use operator
read access for these records; the public CLI does not expose Run commands.

### `queued` for longer than normal

The durable record exists but dispatch has not taken ownership.

1. Check SQS age, visible/in-flight counts, dispatcher Lambda errors/throttles, and its event-source
   mapping.
2. Check the dispatcher role can read the run/input and start only the configured backend.
3. Check the scheduled reconciler. Every minute it re-enqueues at most 500 `queued` runs older than
   the configured age (90 seconds by default), repairing the record-created/message-not-sent crash
   window. It also checks bounded batches of stale unattached `dispatching`/`running` executions and
   unlaunched cancellations. An idempotent client retry also re-nudges the same queued run.
4. Check the DLQ before sending any manual wake-up. Duplicate SQS delivery is normally safe, but
   manual replay can create noise and cost.

An SQS send failure leaves the record `queued` even though the submit request returns an error. After
fixing SQS/IAM, repeat the exact request with the same idempotency key. Retrying without a key can
create a duplicate when the reconciler later wakes the first run.

### `dispatching` without an execution reference

The dispatcher advanced state but did not durably attach a backend ID. Review dispatcher logs and
CloudTrail for `RunMicrovm` or EC2 `RunInstances`, according to placement. The scheduled
reconciler re-nudges stale `dispatching` and `running` records with no execution or `id: pending`; the backend uses the run ID as a client token,
so retrying the start is intended to return the same execution.

A newly launched worker waits up to 60 seconds for this attachment before it will start the agent.
If repair does not complete in that window, it records a terminal failure and exits.
Inspect supervisor shutdown and the Agents completion stream to confirm that the
Session observes the failure and the worker releases compute.

- Confirm the reconciler ran after the age threshold and the dispatcher attached the returned ARN/ID.
- If no execution was created, diagnose backend start/IAM/quota errors before a new submission.
- If an execution exists, correlate its ARN/ID and determine whether it is active before cancellation
  or repair; do not assume a missing handle means no MicroVM launched.
- Do not edit the DynamoDB status casually. The state machine and notifier assume conditional,
  monotonic terminal transitions.

Escalate for audited state repair when the control API cannot safely reach a terminal state.

### A Turn stalls while its private Run remains `running`

1. Inspect the execution ID in the run record.
   If it is missing or `pending`, check the unattached-launch reconciliation path first.
2. For a fenced attachment, compare `heartbeatAt` with the configured stale threshold and inspect
   `liveness`. `active` means the reconciler proved the exact root-supervised worker despite a stale
   DynamoDB heartbeat. `conflict` or `unknown` with `quarantinedAt` requires operator review; do not
   terminate an execution whose generation cannot be proven.
3. Inspect backend state, image/AMI configuration, connector selection, execution-role errors,
   lifecycle logs and lifetime. `execution_lost` can mean confirmed worker loss or
   expiry after one hour without keep-alives; inspect its bounded message.
4. Check model/provider latency and repository-clone/network failures.
5. If the execution is alive and cancellation is safe, use:

   ```bash
   npm run rat-things -- sessions cancel SESSION_ID
   ```

The reconciler checks stale attached executions against the exact worker generation.
Confirmed worker loss fails that attachment. Suspended MicroVMs are retained without
probing their frozen listener. Active workers with no keep-alive for one hour expire;
a trusted resume timestamp starts a fresh grace period. Session recovery depends on
the environment and available checkpoint. Review possible external effects before retrying work.

### `cancelling` does not finish

For an active Turn, the console's Stop and `rat-things sessions cancel SESSION_ID`
request graceful interruption and preserve the Session. Inspect saved partial Items and
artifacts after the Turn settles. If it has not reached a running worker, cancellation
uses the private Run cancellation path instead.

`rat-things sessions delete SESSION_ID` closes the whole harness and queued input. Use it
only when the Session is no longer needed. Neither operation retracts provider posts or
other external effects.

For a private Run stuck in `cancelling`, inspect its exact execution attachment. The
reconciler repeats termination only for a verified generation and finalizes once the
backend is terminal or absent. It finalizes unattached cancellations directly and
quarantines identity conflicts. Preserve evidence before any operator repair.

### `failed`

Use `error.code`, bounded message, worker events, backend reason, and adjacent logs. Common classes:

| Code/symptom | Investigate |
| --- | --- |
| Submit failed while record remains `queued` | SQS URL/policy, KMS if configured, throttling, network; retry the same idempotency key |
| `repository_checkout_failed` | Host allowlist, ref existence, secret scope/expiry, DNS/egress, redirect behavior |
| `agent_timeout` | Timeout sizing, model latency, repository size, tool loop, backend duration |
| `agent_failed` | Driver binary/config/auth, Bedrock model access, output-schema failure, OOM/disk |
| `execution_lost` | Confirmed worker loss or one-hour keep-alive expiry; inspect the exact generation and review possible side effects before retrying |
| Dispatch error mentioning backend disabled | The privately selected MicroVM or EC2 backend is disabled, unprovisioned or misconfigured |
| MicroVM image `UNPROVISIONED` | Explicit provisioning was not completed; stop new dispatch while repairing |

An idempotent retry of input preserves its receipt; new input is new work. Fix the cause
and inspect saved outcomes before choosing either. Never reset a terminal private Run
to `queued`.

## Session schedule triage

Read `rat-things schedules get SCHEDULE_ID` under the owning identity. Confirm
status, expression, timezone, Agent, environment and generation. Paused or stale
generations accept no new occurrences; an accepted occurrence retains its input.

Inspect the Agents outbox for schedule synchronization failures and the
`thing_schedule_failure_queue_url` output for failed EventBridge target delivery.
The `thing-schedule` Lambda and its schedule group execute Session schedules.

Correlate the schedule ID and scheduled time with its stored occurrence and
Session ID. Preserve failed queue messages until the cause is repaired; replaying
the same occurrence must reuse its receipt. Change schedules through the control
API so stored generations and AWS targets remain synchronized.

## Webhook triage

### `401 invalid_signature` / `invalid_token`

- Confirm the provider is calling the URL for the same environment as the secret ARN.
- Confirm no proxy rewrites or re-encodes the request body before API Gateway/Lambda verification.
- Confirm secret JSON uses a supported field or raw value; for Teams, the HMAC key is the base64
  secret issued for that outgoing webhook.
- For GitLab 19 Standard Webhooks, confirm a `whsec_` signing token, `webhook-id`,
  `webhook-timestamp`, and `webhook-signature`; an invalid Standard signature intentionally never
  falls back to `X-Gitlab-Token`. Legacy-token auth is only used when the signature header is absent.
- For Slack, confirm clock skew is under five minutes.
- Inspect secret version/rotation timing without printing its value. Warm functions cache secrets for
  five minutes.

Do not disable verification to debug. Use a provider test/redelivery or a locally generated fixture
with a non-production secret.

### Authenticated but ignored

`202 {"accepted":false,"ignored":true}` is expected for unsupported GitHub/GitLab/Slack events. Check
the event/action matrix in [channels](channels.md). Teams returns `400 invalid_activity` for an
authenticated activity lacking its required IDs or non-empty prompt.

If expected comments do not trigger, check the case-insensitive configured command trigger
(`@rat-things` by default). A trigger mention is a noise/cost gate, not authorization. Do not “fix”
delivery by broadening provider event subscriptions beyond the documented set.

### Duplicate webhook

Correlate the provider delivery/activity/event ID with the stored input receipt. The
binding and provider thread determine the Session ID. Identical replays reuse the
receipt; the same occurrence with different input returns an idempotency conflict.
Investigate that conflict as a provider/configuration or integrity anomaly.

## Notification triage

Provider replies follow saved terminal root Turns through the Agents outbox. They do
not wait for the private harness Run to exit, and the Run notifier intentionally skips
Session executions.

1. Confirm the input receipt has a Turn ID, the root Turn is terminal, and its Items
   are saved. Inspect `session_integrations`, the Agents table stream, FIFO queue and
   `agents-outbox` delivery job. Subagent completion is not a provider reply trigger.
2. Check the binding's source, destinations and notification connection set. A `none`
   destination suppresses delivery. A direct API Session has no provider reply target
   unless an integration supplies one.
3. Inspect the per-destination delivery fence, keyed by Turn ID for Session replies.
   An input marked `deliveryProcessed` means the delivery attempt was processed;
   the fence records whether the provider accepted it.
4. HTTP 429 releases the fence for queue retry. Missing configuration and permanent
   provider rejections become `not_delivered`; fix the cause before an audited replay.
   HTTP 5xx and unclassified failures become `outcome_unknown`, because the provider
   may already have accepted the write. Do not blindly retry them.
5. A `sending` fence has a 120-second lease. Redelivery before expiry stays retryable;
   an expired lease becomes `outcome_unknown` without another provider write. Search
   the provider thread for the Turn ID and reconcile the outcome before any audited replay.
6. Inspect the Agents failure queue for exhausted delivery jobs. Retain each message
   until the cause is repaired and its receipt/fence is reconciled. There is no public
   provider-notification retry API.

For non-Session execution events, the separate state-stream/notifier path still uses
EventBridge `Agent Run State`. Exhausted state-stream invocations go to
`state_stream_failure_queue_url`; retain the shard/sequence metadata for replay while
stream records exist. After stream expiry, reconstruct only the bounded event from
the durable Run. EventBridge notifier failures go to
`notifier_delivery_failure_queue_url` after up to 24 hours and 185 attempts. Verify the
Run's delivery fence before deleting either failure item. Never mutate terminal state
to force another notification.

Provider checks:

- GitHub: token scope/repository installation, issue number, API rate limit.
- GitLab: token scope/project ID/MR IID, API base URL, rate limit.
- Teams bridge: Workflow owner/co-owner state, flow run history, URL rotation, default/named route
  secret mapping, destination, and Power Automate throttling. The Workflow may not be the originating
  thread; unknown named routes are rejected.
- Slack: app installation, bot `app_mentions:read`/`chat:write`/`reactions:write`, delegated-user
  `search:read`, channel membership, one verified-workspace source binding, bot versus `user_*`
  expiry metadata, and Slack's bounded `ok:false` error code. Never print either token family.

Generated output may contain secrets, private code, or mass mentions. If disclosure is suspected,
remove/contain the provider message using provider procedures, revoke affected credentials, preserve
restricted evidence, and follow the incident plan.

## MicroVM-specific incidents

Before diagnosing workload code, confirm:

- the Region currently supports Lambda MicroVMs;
- the Terraform-pinned managed base-image version is still `AVAILABLE`;
- image SSM parameters contain a provisioned ARN rather than `UNPROVISIONED`;
- AWS-managed egress and DNS can reach required public endpoints;
- hook payload is under 4,096 bytes and lifecycle endpoints return the expected states; and
- the base-image snapshot contains no run-specific data or credentials. Session
  suspension/checkpoints are separate, private state and need their configured protection.

Pause dispatch during a MicroVM control-plane incident. Submit only non-sensitive explicit canaries
after the service recovers. Terminate existing VMs only after resolving exact IDs and preserving
evidence.

### Slow conversation startup or Codex initialization

Startup has four phases: queueing, AWS launch/resume acceptance, host storage preparation, and
Codex initialization. `QueueDelay` and the dispatcher launch/resume request durations cover the
first two. The MicroVM's `agent runner started` entry reports `startupDurationMs`,
`storageMountDurationMs`, `storagePreparationDurationMs`, and `storageAlreadyMounted`. These host
measurements exclude Codex initialization. Compare fresh and resumed conversations before
attributing a delay to model inference.

For a Codex initialization failure, retain the exact binary version and bounded app-server stderr,
and distinguish a child-process error from a test or caller deadline. Investigate using isolated
state directories. Durable Codex home includes SQLite state needed for native-thread restoration;
do not delete it or move it to temporary storage as a troubleshooting shortcut. Slow initialization
alone does not establish database corruption.

## Secret rotation

1. Identify whether the value authenticates ingress, clone/model access, or outbound notification.
   Never reuse rotation as an opportunity to merge identities.
2. Create a new secret version or provider credential with the minimum scope.
3. Update the corresponding provider configuration/Terraform ARN in a controlled order. Most current
   webhook verifiers accept one value, so plan a brief coordinated cutover.
4. Allow for the five-minute in-process cache, then send a non-production canary.
5. Revoke the old value only after all environments/providers point to the new one.
6. If exposure is suspected, revoke first, accept the interruption, and follow incident response.

Never place the new value in Terraform variables/state; pass only an existing Secrets Manager ARN.

## Rollback

- **MicroVM image:** apply the previously known-good pinned source/base-image version. Let known-good
  active runs finish or cancel them by exact ID.
- **Webhook cutback:** restore a previously validated endpoint only if its bindings,
  credentials and ownership remain compatible. Keep environments separate and watch
  for duplicate provider occurrences during the switch.
- **Control client cutback:** restore the prior API base URL in the caller's configuration. Do not
  merge old/new run IDs or storage tables.
- **Terraform:** review the saved plan and state before applying. Do not use destructive state/reset
  commands or `force_destroy_data=true` as an incident shortcut.

`force_destroy_data=false` protects only non-empty S3 deletion. It does not retain DynamoDB,
SQS, CloudWatch Logs, or KMS during a full Terraform destroy; rely on the deployment's reviewed
backup/deletion-protection policy, not that flag, for recovery data.

## Incident closeout

Close only after the run/provider outcome is known, queue/backlog is healthy, delivery ambiguity is
reconciled, canaries pass, and alert noise stops. Capture a redacted timeline, root cause, affected
owners/repos/destinations, cost and data exposure, corrective actions, and whether the security model,
tests, alarms, or deployment gates need revision.
