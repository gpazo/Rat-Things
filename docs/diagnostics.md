# Diagnostics for consumers and operators

Rat Things adds durable state and isolated execution so failures can be inspected rather than lost.
The debugging contract is part of the product: use machine-readable discovery, stable error
envelopes, Thing explanations, run state, and retained events in that order.
This follows the same [operating journey](operating-model.md): diagnose installation and discovery,
then the account, then the Thing's effective permissions, and finally the individual run.

## Start with doctor

```bash
export RAT_THINGS_API_URL="https://..."
export AWS_REGION="us-west-2"
rat-things doctor
rat-things doctor --json
```

The command checks Node compatibility, API URL/Region inference, public `/health`, public
`/.well-known/rat-things`, and an authenticated `GET /v1/capability-profiles`. JSON output has a
stable `version`, overall `ok`, and checks with `pass`, `warning`, or `fail` status. A warning means
a local-only workflow may still work; a failed authenticated API check means remote control is not
ready.

Common repairs:

| Check | Likely repair |
| --- | --- |
| `api-url` warning | Set `RAT_THINGS_API_URL` to the module `api_endpoint` output |
| `aws-region` warning | Set `AWS_REGION`, or use the API Gateway hostname from the deployment |
| `api-health` failure | Verify URL, DNS/TLS, API route, control Lambda init, and deployment Region |
| `discovery` failure | Deploy current control routes and Lambda package together |
| `authenticated-api` failure | Refresh AWS credentials; verify execute-api invoke permission and SigV4 Region |

`/health` is liveness only. It does not prove model access, MicroVM provisioning, an integration
credential, or a particular Thing.

## Debug an integration connection

Start from discovery instead of guessing a provider's fields:

```bash
rat-things plugins > plugins.json
rat-things connections > connections.json
```

Find the plugin's `authentication` entry and make the credential file contain exactly those keys.
Use a non-secret path, owner-only file permissions, and never put the value on the command line:

```bash
chmod 600 /secure/tmp/provider.json
rat-things connect PLUGIN --credential-file /secure/tmp/provider.json --access read-only
```

Connection creation follows four independently inspectable stages:

| Stage | Failure meaning | Repair |
| --- | --- | --- |
| Manifest discovery | Plugin absent or scheme unavailable | Deploy/register the plugin; choose a listed scheme |
| Local/API field validation | Missing, empty, or extra credential key | Match the manifest field keys exactly |
| Provider verification rejected | `400` and no connection/secret created | Reissue the credential; check provider account/status and plugin identity endpoint |
| Provider verification unavailable | `503 integration_unavailable` | Preserve the form and retry with backoff; check egress, DNS/TLS, provider status, and throttling |
| Persistence | `500` with a trace ID | Inspect control Lambda, Secrets Manager, DynamoDB, KMS, and provider reachability |

A successful response should have Rat-derived `label`, `externalTenantId` and/or
`externalSubjectId`, and `authorization`. If those are wrong, fix the trusted plugin verifier; do
not work around it by accepting caller-supplied metadata.

For a connection that exists but exposes no expected tool, inspect in this order:

1. provider `authorization.access`, `scopeModel`, and `scopes` from `rat-things connections`;
2. the persistent Rat `grant` returned beside that connection;
3. the selected capability profile;
4. the Thing/run connection selection and any deny list; and
5. the operation's required scopes, resource constraints, and approval policy.

`rat-things thing-explain THING_ID` shows that intersection without reading the credential. A broad
provider key with a read-only Rat grant is expected; widening the key is not a fix for a broker
denial. To rotate, use the same credential-only shape:

```bash
rat-things rotate ACCOUNT --credential-file /secure/tmp/provider-rotated.json
```

Rotation rejects a credential for a different provider tenant/subject. Create another connection
for that account instead. Revocation is terminal for the connection; reconnect as a new account if
it is needed again.

## Explain a Thing

```bash
rat-things thing-explain THING_ID > explanation.json
```

Repair every `error` diagnostic before publishing. In particular:

- install or select an existing capability profile;
- create a referenced connection set for the same authenticated owner;
- correct account aliases/IDs and reactivate or rotate expired connections;
- add a persistent Rat permission grant;
- remove operation IDs not present in the installed plugin manifest; and
- inspect each operation's provider, grant, Thing, profile, approval, and resource ceilings.

The explanation contains no credential values. If its direct `compiledRun` differs from
`effectiveRun`, the capability profile narrowed the request. A denied write in `resolvedConnections`
is expected when a Thing asks for read-only access; do not widen the provider token merely to make
the explanation look uniform.

The latest draft runs through `thing-test`; the active revision runs through `thing-run`, including
while its schedule is paused. Archived Things do not run.
Use a unique test idempotency key for a changed test; repeat the same key only when retrying the same
semantic attempt.

## Read stable API errors

Control and webhook transport failures use:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Thing spec trigger.kind must be manual or schedule",
    "retryable": false,
    "traceId": "API_GATEWAY_REQUEST_ID"
  }
}
```

| HTTP/code | Meaning | Client behavior |
| --- | --- | --- |
| `400 invalid_request` | Contract or state input is invalid | Fix the request; do not retry unchanged |
| `403 forbidden` | Principal absent or owner boundary denied | Repair authentication/ownership; never search other IDs |
| `404 not_found` | Route or owner-visible object absent | Check deployment version and owner-scoped ID |
| `409 conflict` | Stale revision, lifecycle conflict, or unavailable interaction | Refresh state, reconcile intent, then retry deliberately |
| `503 integration_unavailable` | Provider verification is temporarily unavailable | Retry with bounded backoff; preserve the credential outside logs |
| `500 internal_error` | Unexpected storage/runtime failure | Correlate `traceId`; retry only when `retryable` is true |

The server logs bounded error metadata for internal failures, never the raw secret. Preserve the
trace ID in support tools and application logs. Do not turn a 4xx into an automatic retry loop.

## Follow a run

After `thing-run` returns `202`, use:

```bash
rat-things get RUN_ID
rat-things watch RUN_ID --follow
rat-things files --run RUN_ID --json
rat-things output RUN_ID
```

Interpret durable states before looking at infrastructure:

- `queued`: record exists; inspect SQS and dispatcher if stale;
- `dispatching`: a backend is being attached; inspect MicroVM lifecycle if stale;
- `running`: use live events, pending approvals, steering, and interruption;
- `cancelling`: cancellation requested; wait for backend or reconciler finalization;
- `succeeded`: inspect output and user-visible file catalog;
- `failed`: use bounded `error`, terminal events, and artifacts; and
- `cancelled`: no more agent work should occur, though prior external effects remain.

Live events are a bounded in-MicroVM view. The terminal JSONL artifact is the durable audit source.
If a run fails before attachment, live events may never exist; use the run record, queues, and Lambda
logs instead.

## Verify storage and scheduling

For a Thing that disappears or fails digest validation:

1. confirm `THINGS_TABLE_NAME` and `DEFINITION_BUCKET` are present in the control/Scheduler Lambda
   environments;
2. confirm the authenticated principal matches the Thing owner;
3. verify the Thing root and immutable version item exist in DynamoDB without copying the goal;
4. verify the referenced object exists below `owners/<owner-hash>/things/<id>/versions/` in the
   private definition bucket;
5. verify the Lambda role has table, S3-object, and data-key permissions; and
6. do not rewrite an immutable definition object to repair a digest—create a new revision or restore
   the exact version from controlled backup.

For an active schedule that does not fire, inspect `triggerState` first. `error` contains the bounded
Scheduler API failure; retry `thing-publish` or `thing-resume` after repairing it. Then inspect the
deployment's EventBridge Scheduler group, the exact schedule's expression/time zone/state/target,
its fixed invocation role, the Thing Scheduler Lambda logs, the schedule failure queue, SQS send
permission, and the run table. Confirm the schedule payload pins the current `active.revision` and
uses `<aws.scheduler.scheduled-time>`. Stale or paused deliveries intentionally produce no run.

## Deeper operator runbook

This guide covers public diagnostics. Queue redrive, delivery fencing, stream failure queues,
MicroVM incidents, secret rotation, and destructive recovery procedures remain in the
[operator runbook](runbook.md). Architecture boundaries and data ownership are described in
[architecture](architecture.md) and [security](security.md).
