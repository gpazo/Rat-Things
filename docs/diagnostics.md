# Diagnostics for consumers and operators

Rat Things adds durable state and isolated execution so failures can be inspected rather than lost.
The debugging contract is part of the product: use machine-readable discovery, stable error
envelopes, Session state, Turn outcomes, and retained events in that order.
This follows the same [operating journey](operating-model.md): diagnose installation and discovery,
then the account, then the Agent's declared capabilities, and finally the individual run.

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
credential, or a particular Agent.

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

For an OAuth definition, first inspect `oauthInstallation`. `configured` supports
`rat-things connect PLUGIN --oauth --wait`; `host-required` means the operator must register the reported
callback URL and add the provider app secret ARN to `integration_oauth_app_secret_arns`. A callback
page failure consumes the one-time state, so restart the CLI flow rather than replaying the URL.

Connection creation follows four independently inspectable stages:

| Stage | Failure meaning | Repair |
| --- | --- | --- |
| Manifest discovery | Plugin absent or scheme unavailable | Deploy/register the plugin; choose a listed scheme |
| OAuth application setup | Manifest reports `host-required` | Register the exact callback URL, create the `client_id`/`client_secret` JSON secret, set its Terraform ARN, and apply |
| OAuth callback/state | Consent declined, callback expired, or state replayed | Start a fresh authorization; do not reuse a callback URL |
| OAuth refresh | Expired token family lacks its refresh token, the app config was removed, or one provider-family response is being parsed as an initial multi-token exchange | Reconnect the account or restore the same provider app configuration; for Slack inspect bot and `user_*` expiry/refresh metadata independently without printing token values |
| OAuth reconnect | Consent completed with a different workspace/user, or the connection was revoked | Repeat while selecting the same provider account; create a separate Connection for a different identity; revoked connections cannot be reactivated |
| Scheduled health | Health remains old or unknown | Confirm `enable_connection_health_monitor`, the EventBridge rule, connection-health Lambda metrics, integration-table scan permission, and exact connection/app-secret IAM paths; never log provider bodies or credential values |
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
4. the Run connection selection and any deny list; and
5. the operation's required scopes and resource constraints.

Inspect the declared tools and attached Vaults for an Agents Session. A broad
provider key with a read-only Rat grant is expected; widening the key is not a fix for a broker
denial. To rotate, use the same credential-only shape:

```bash
rat-things rotate ACCOUNT --credential-file /secure/tmp/provider-rotated.json
```

Rotation rejects a credential for a different provider tenant/subject. Create another connection
for that account instead. Revocation is terminal for the connection; reconnect as a new account if
it is needed again.

## Inspect an Agent and Session

```bash
rat-things agents get agent_example
rat-things sessions get sess_example
rat-things sessions turns sess_example
rat-things sessions items sess_example
```

Check the Session's snapshotted Agent configuration, environment and required
actions. Later Agent changes do not affect that Session. Verify declared tools,
owned Vaults, deployment policy and environment capability before starting another
Session to change its authority. Provider bindings also require the owned Agent
and environment; a notification connection set does not supply Agent tools.

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

For remaining legacy Run-based application integrations, use:

```bash
rat-things get RUN_ID
rat-things watch RUN_ID --follow
rat-things files --run RUN_ID --json
rat-things output RUN_ID
```

Interpret durable states before looking at infrastructure:

- `queued`: record exists; inspect SQS and dispatcher if stale;
- `dispatching`: a backend is being attached; inspect MicroVM lifecycle if stale;
- `running`: use live events, ordinary pending input, steering, and interruption;
- `cancelling`: cancellation requested; wait for backend or reconciler finalization;
- `succeeded`: inspect output and user-visible file catalog;
- `failed`: use bounded `error`, terminal events, and artifacts; and
- `cancelled`: no more agent work should occur, though prior external effects remain.

Live events are a bounded in-MicroVM view. The terminal JSONL artifact is the durable audit source.
If a run fails before attachment, live events may never exist; use the run record, queues, and Lambda
logs instead.

## Verify storage and scheduling

For a missing Agent or Session, verify the authenticated owner and the Agents
resource index. Confirm the referenced encrypted definition object exists and
that the service role has table, object and data-key permissions. Do not edit
stored content to work around a failed integrity check.

For a schedule that does not fire, inspect its stored status and generation, the
Agents outbox, the AWS schedule expression/timezone/target and the fixed invocation
role. Check the scheduler failure queue before replaying an occurrence. Paused
and stale generations accept no new work. Use the [schedule triage guide](runbook.md#session-schedule-triage).
