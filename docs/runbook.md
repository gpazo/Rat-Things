# Operational runbook

This runbook assumes an operator with read access to the runtime stack, CloudWatch Logs/Metrics,
DynamoDB run records, SQS, S3 metadata, and Lambda MicroVM APIs. Use a separately
audited break-glass role for mutations not exposed by the control API.

## First response

Before investigating a run, establish the exact account, Region, environment, and deployment
revision. Dev and production secrets, webhook URLs, queues, artifact buckets, roles, and source
installations must remain separate.

```bash
aws sts get-caller-identity
terraform -chdir=infra workspace show
terraform -chdir=infra output -json
npm run build
npm run rat-things -- doctor
```

Set `AWS_REGION` and `RAT_THINGS_API_URL` from the intended stack output, then inspect the run as
its owning API identity:

```bash
npm run rat-things -- get RUN_ID
npm run rat-things -- output RUN_ID
npm run rat-things -- artifact RUN_ID events
```

Webhook-owned runs are intentionally not visible to an unrelated API principal. Use administrative
AWS read access and the provider delivery/activity ID to correlate them; do not weaken ownership or
enable `ALLOW_OWNER_HEADER` in a deployed environment.

Record this evidence before changing anything:

- run ID, owner/source kind, status, created/updated/cancel times, request hash, and execution ID;
- API Gateway request ID or provider delivery/activity ID;
- SQS message receive count and DLQ presence;
- dispatcher, worker, state-stream, and notifier log timestamps;
- MicroVM state/termination reason;
- terminal EventBridge event and provider delivery receipt/fence status; and
- deployment/image revision plus any active AWS/provider incident.

Do not paste prompts, repository contents, presigned URLs, headers, secret values, or full model event
streams into tickets or chat.

## Health and service map

`GET /health` checks only that API Gateway can invoke the control Lambda. It does not check DynamoDB,
S3, SQS, MicroVMs, model access, repository access, or notification providers.

Expected log-group naming for a stack named `<prefix>-<environment>` is:

```text
/aws/lambda/<name>-control
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

## Run status triage

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
CloudTrail for `RunMicrovm`. The scheduled reconciler re-nudges stale `dispatching` and
`running` records with no execution or `id: pending`; the backend uses the run ID as a client token,
so retrying the start is intended to return the same execution.

A newly launched worker waits up to 60 seconds for this attachment before it will start the agent.
If repair does not complete in that window, it records a terminal failure and exits. A one-shot VM
self-terminates through its supervisor; a conversation VM is suspended by the completion path and
must be inspected if that terminal event cannot be folded into the mailbox.

- Confirm the reconciler ran after the age threshold and the dispatcher attached the returned ARN/ID.
- If no execution was created, diagnose backend start/IAM/quota errors before a new submission.
- If an execution exists, correlate its ARN/ID and determine whether it is active before cancellation
  or repair; do not assume a missing handle means no MicroVM launched.
- Do not edit the DynamoDB status casually. The state machine and notifier assume conditional,
  monotonic terminal transitions.

Escalate for audited state repair when the control API cannot safely reach a terminal state.

## Thing schedule triage

Start with the owner-scoped Thing record, not the AWS console:

```bash
npm run rat-things -- thing THING_ID
npm run rat-things -- thing-explain THING_ID --target active
```

- `status: draft` means nothing is published. Test the draft, then publish it.
- `status: paused` intentionally prevents scheduled delivery; an explicit `thing-run` still uses
  the active revision.
- `triggerState.status: error` contains the bounded Scheduler synchronization error. Repair IAM,
  quota, expression, target, or service availability, then retry the same `thing-publish` or
  `thing-resume`; lifecycle synchronization is idempotent.
- `triggerState.status: ready` means Rat synchronized the active revision. Inspect the Terraform
  `thing_schedule_group_name` output, the schedule expression/time zone/state, its fixed target and
  invocation role, `/aws/lambda/<name>-thing-schedule`, and the encrypted queue from
  `thing_schedule_failure_queue_url`.
- Confirm the Scheduler input pins the current `active.revision` and carries
  `<aws.scheduler.scheduled-time>`. The target deliberately acknowledges a stale revision, paused or
  archived Thing, or non-schedule definition without creating a run.
- For an accepted occurrence, correlate the Thing ID, revision, and scheduled time with the run's
  `metadata.thingInvocation`. Those fields form its deterministic occurrence identity, so replaying
  the same delivery must resolve to the same run.

Do not edit the schedule target, role, or payload manually. Publish, pause, resume, and archive own
that state through the control API. If the failure queue contains an item, preserve it until the
cause is repaired and the pinned occurrence has been reconciled.

### `running` longer than `timeoutSeconds` plus start-up allowance

1. Inspect the execution ID in the run record.
   If it is missing or `pending`, check the unattached-launch reconciliation path first.
2. For a fenced attachment, compare `heartbeatAt` with the configured stale threshold and inspect
   `liveness`. `active` means the reconciler proved the exact root-supervised worker despite a stale
   DynamoDB heartbeat. `conflict` or `unknown` with `quarantinedAt` requires operator review; do not
   terminate an execution whose generation cannot be proven.
3. Inspect the MicroVM state, image parameters, managed-connector selection, execution-role errors,
   lifecycle hook logs, and maximum duration. `execution_lost` means the reconciler proved that the
   exact attached backend or worker was absent and conditionally failed the unchanged generation.
4. Check model/provider latency and repository-clone/network failures.
5. If the execution is alive and cancellation is safe, use:

   ```bash
   npm run rat-things -- cancel RUN_ID
   ```

The scheduled reconciler repairs a dead attached MicroVM after two missed heartbeat windows. It
does not create a replacement semantic Run. Submit a new idempotency identity only after reviewing
whether the lost execution could already have caused an external side effect.

### `cancelling` does not finish

Confirm `TerminateMicrovm` reached the execution ID, then check whether the worker
observed `SIGTERM`/abort and committed `cancelled`. Repeating the API cancellation safely repeats the
stop call when an execution is attached. The scheduled reconciler finalizes an unattached
cancellation directly. For an attached generation, it proves the backend identity, repeats
termination only for that exact attachment, and conditionally finalizes once AWS reports it
terminal or absent. Identity conflicts are quarantined. Cancellation cannot retract an
already-published provider message or other external side effect.

### `failed`

Use `error.code`, bounded message, worker events, backend reason, and adjacent logs. Common classes:

| Code/symptom | Investigate |
| --- | --- |
| Submit failed while record remains `queued` | SQS URL/policy, KMS if configured, throttling, network; retry the same idempotency key |
| `repository_checkout_failed` | Host allowlist, ref existence, secret scope/expiry, DNS/egress, redirect behavior |
| `agent_timeout` | Timeout sizing, model latency, repository size, tool loop, backend duration |
| `agent_failed` | Driver binary/config/auth, Bedrock model access, output-schema failure, OOM/disk |
| `execution_lost` | A generation-fenced heartbeat went stale and the exact MicroVM or supervised worker was proven absent; review possible side effects before submitting a new Run |
| Dispatch error mentioning backend disabled | Requested `microvm` without an enabled/provisioned backend or invalid deployment default |
| MicroVM image `UNPROVISIONED` | Explicit provisioning was not completed; stop new dispatch while repairing |

Retries are new semantic runs. Fix the cause, choose a new idempotency key, and retain the failed run
for audit. Do not mutate a terminal record back to `queued`.

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

Correlate provider delivery/activity/event ID with the deterministic run ID. Identical replays should
return the existing run. A conflict means the same idempotency identity arrived with a different
canonical request and should be investigated as a provider/configuration or integrity anomaly.

## Notification triage

1. Confirm a terminal run produced an EventBridge `Agent Run State` event. If terminal state exists
   without an event, inspect state-stream Lambda errors and the event-source mapping. The current
   mapping retries ten times with a maximum 24-hour record age, then sends failed invocation metadata
   to the encrypted SQS queue from `state_stream_failure_queue_url` and raises its CloudWatch alarm.
   Read but do not delete that message. Within stream retention, use its stream/shard/sequence range
   to replay through the state-stream handler. After expiration, reconstruct the bounded state event
   from the durable run record, verify downstream delivery, and only then delete the failure item.
   Do not mutate the terminal run.
2. Confirm the stored request resolves to at least one non-`none` destination. Plain API runs with the
   default `source` destination intentionally have no reply target.
3. Inspect notifier logs and its delivery-fence item before retrying.
4. A confirmed HTTP 429/5xx non-delivery releases the fence and fails the invocation so EventBridge
   retries. Other errors, including unclassified Secrets Manager, DNS, or network failures, are
   recorded as `outcome_unknown` to prevent a blind duplicate.
5. `sending` owns a 120-second lease. Redelivery before expiry throws and remains retryable; after
   expiry it conditionally reclaims the lease and posts again. This repairs a notifier crash/timeout,
   but can duplicate a post that the provider accepted just before the crash. Correlate by run ID.
6. EventBridge retries a failed notifier target for up to 24 hours and 185 attempts. If exhausted,
   inspect the encrypted queue from `notifier_delivery_failure_queue_url` and the visible-message
   alarm; also check the `InvocationsFailedToBeSentToDLQ` alarm. Fix target/invoke/provider behavior,
   redrive each retained terminal event, verify its delivery fence, and only then delete the DLQ
   message.
7. For `outcome_unknown`, search the provider thread/channel for the run ID. If it arrived, record the
   reconciliation. If it did not, use an audited, provider-aware replay procedure; there is no public
   notification-retry API.

Provider checks:

- GitHub: token scope/repository installation, issue number, API rate limit.
- GitLab: token scope/project ID/MR IID, API base URL, rate limit.
- Teams bridge: Workflow owner/co-owner state, flow run history, URL rotation, default/named route
  secret mapping, destination, and Power Automate throttling. The Workflow may not be the originating
  thread; unknown named routes are rejected.
- Slack: app installation, `chat:write` scope, channel membership, bot token, `ok:false` error.

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
- no snapshot contains run-specific data or credentials.

Pause dispatch during a MicroVM control-plane incident. Submit only non-sensitive explicit canaries
after the service recovers. Terminate existing VMs only after resolving exact IDs and preserving
evidence.

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

## Rollback and migration cutback

- **MicroVM image:** apply the previously known-good pinned source/base-image version. Let known-good
  active runs finish or cancel them by exact ID.
- **Webhook cutback:** restore the provider callback URL to the retained
  `indubitably-serverless` endpoint. Keep secrets and events environment-specific; watch for duplicate
  delivery during the switch.
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
tests, alarms, or migration gates need revision.
