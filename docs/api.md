# Control API and v1 run contract

The control API is an internal asynchronous API. Submission returns a run record immediately; the
caller polls or consumes the configured completion destination. It does not hold an HTTP connection
open for the agent.

> The current response projection is the stored `RunRecord`, including owner and S3 artifact
> coordinates. Keep the API behind AWS IAM/JWT authorization and do not expose it directly to an
> untrusted browser client. A public-safe projection and authorized artifact-download endpoint are
> roadmap items.

## Authentication and ownership

Except for `GET /health`, every control route requires a principal supplied by API Gateway:

- an IAM authorizer's `userArn` or `callerId`; or
- a JWT authorizer's `sub` claim.

The handler derives `ownerId` from that value. A caller cannot supply or select its owner. The
`X-Runtime-Owner` escape hatch works only when `ALLOW_OWNER_HEADER=true`; this is for isolated local
testing and must be false in a deployed stack.

The included Terraform module configures `AWS_IAM` on every control route and no authorization on
`GET /health`. JWT principal extraction is a handler capability for a separately reviewed API
Gateway configuration; it is not enabled by the provided root stack.

Runs are readable, listable, and cancellable only by the exact derived owner. Webhook-created runs
use provider-specific owner namespaces and are therefore not automatically visible to an API user.
Cross-identity lookup is an administrative capability outside v1.

## Routes

| Method and path | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | None | Liveness response; does not prove worker/model/provider readiness |
| `POST /v1/conversations/{conversationId}/messages` | Required | Append one owner-scoped durable conversation turn and return `202` |
| `GET /v1/conversations/{conversationId}/messages/{messageId}` | Required | Poll the exact message, bound run, conversation, and suspended-session state |
| `POST /v1/runs` | Required | Validate, durably store, enqueue, and return `202` |
| `GET /v1/runs?limit=25&nextToken=...` | Required | Newest-first runs for the current owner; limit is clamped to 1–100 |
| `GET /v1/runs/{runId}` | Required | Current record for the current owner |
| `GET /v1/runs/{runId}/artifacts/{name}` | Required | Owner-checked, short-lived download URL for `input`, `output`, `events`, or `patch` |
| `POST /v1/runs/{runId}/cancel` | Required | Request cancellation and return `202`; terminal runs are unchanged |

`nextToken` is opaque and must be returned unchanged. There is currently no result stream,
approval route, or caller-selected MicroVM resume route. Durable conversation continuation is
selected by trusted orchestration from the stored owner-scoped session.

## Headless durable conversations

The conversation routes are the headless equivalent of a provider thread. They enter the same
DynamoDB/S3 mailbox, SQS coordinator, bounded run, Lambda MicroVM suspend/resume, Codex thread, and
completion path as conversational webhook ingress. They deliberately bypass provider signature
parsing and provider delivery; the control API's IAM principal is the actor and owner, the source is
`api`, and the destination is `none`.

`conversationId` is a caller-visible key containing 1–128 letters, digits, `.`, `_`, `:`, or `-`,
starting with a letter or digit. The runtime hashes the authenticated owner into its internal
conversation ID, so two IAM principals using `smoke` cannot share state. `Idempotency-Key` is
required and becomes the message identity within that conversation. Repeating the same key and
prompt is safe; reusing it for different content returns `409 conflict`.

```http
POST /v1/conversations/release-smoke/messages HTTP/1.1
Content-Type: application/json
Idempotency-Key: 93811d8e-2368-4ff8-9e93-706d344e5c8e

{
  "version": "1",
  "prompt": "Use the shell tool to run pwd and report the result.",
  "agent": {
    "driver": "codex",
    "sandbox": "workspace-write",
    "reasoningEffort": "low"
  }
}
```

Only `version`, `prompt`, and `agent` are accepted. The supported durable `agent` fields are
`driver`, `model`, `sandbox`, and `reasoningEffort`. A conversation's execution policy is fixed by
its first message; later attempts to change it return `409`. Callers cannot submit a provider
source, destination, repository credential, output schema, MicroVM ID, Codex thread ID, or auth
mode through this route.

The response is a durable mailbox receipt:

```json
{
  "conversationId": "release-smoke",
  "messageId": "93811d8e-2368-4ff8-9e93-706d344e5c8e",
  "status": "appended"
}
```

Poll its `Location` until `run.status` is terminal. A fully folded successful turn has message state
`consumed`, conversation status `idle`, pending count `0`, and session state `suspended`. The bound
run uses the existing owner-checked artifact route for full output and events:

```json
{
  "conversationId": "release-smoke",
  "messageId": "93811d8e-2368-4ff8-9e93-706d344e5c8e",
  "state": "consumed",
  "delivery": "defer",
  "conversation": {
    "status": "idle",
    "pendingCount": 0,
    "session": {
      "backend": "microvm",
      "id": "mvm-...",
      "state": "suspended",
      "agentThreadId": "..."
    }
  },
  "run": {
    "runId": "...",
    "status": "succeeded"
  }
}
```

The bundled CLI performs the append, polling, completion/suspension check, artifact download, and
SigV4 signing:

```bash
npm run build
export RAT_THINGS_API_URL="$(terraform -chdir=infra output -raw api_endpoint)"
export AWS_REGION="<stack region>"

npm run rat-things -- \
  --thread release-smoke \
  --sandbox workspace-write \
  "Use the shell tool to create marker.txt containing alpha, then read it."

npm run rat-things -- \
  --thread release-smoke \
  --sandbox workspace-write \
  "Read the existing marker.txt and tell me what the previous turn did."
```

With no options, `npm run rat-things -- "your prompt"` uses the owner's default `main` thread. Use
the same thread name and exact execution policy for continuation. Agents can use the explicit
`chat` command and add `--json` to retain run/session evidence, `--no-wait` for a receipt-only
submission, or an explicit
`--idempotency-key` when a supervising test process needs retry-safe message identity. AWS Codex
authentication remains deployment-controlled (normally short-term Bedrock auth); the CLI never
uploads local ChatGPT credentials.

## Submit a run

```http
POST /v1/runs HTTP/1.1
Content-Type: application/json
Idempotency-Key: review-example-01234567

{
  "version": "1",
  "prompt": "Review the checked-out change and return concise Markdown.",
  "repository": {
    "provider": "github",
    "url": "https://github.com/example/repository.git",
    "ref": "0123456789abcdef0123456789abcdef01234567"
  },
  "agent": {
    "driver": "codex",
    "sandbox": "read-only",
    "reasoningEffort": "high"
  },
  "execution": {
    "backend": "microvm",
    "timeoutSeconds": 900
  },
  "destinations": [
    { "kind": "none" }
  ],
  "metadata": {
    "purpose": "manual-review"
  }
}
```

The control handler ignores/replaces any submitted `source` object with
`{"kind":"api","requestId":"<api-gateway-request-id>"}`. Provider sources are created only by
authenticated webhook adapters.

### Idempotency

`Idempotency-Key` is optional and must contain 1–200 characters from
`A-Z a-z 0-9 . _ : -`. Within one owner namespace:

- the same key and canonically identical request return the existing run;
- if that existing run is still `queued`, the retry also sends another safe SQS wake-up;
- the same key and a different request return `409 conflict`; and
- no key creates a random run ID and a new run on every request.

Use a stable business-event ID, not a timestamp, when duplicate submission is possible. GitHub,
GitLab, Teams, and Slack adapters construct their own provider-scoped keys.

The run record is committed before SQS send. If queue send fails, the HTTP request returns an error
but the record remains `queued`; a retry with the **same** idempotency key or the scheduled reconciler
repairs it. Retrying a request without a key can create a second run while the first is later
reconciled, so production callers should always send a key.

## Request fields

Unknown fields are rejected at every validated object level.

### Top level

| Field | Required | Meaning and limits |
| --- | --- | --- |
| `version` | Yes | Literal string `"1"` |
| `prompt` | Yes | Non-empty UTF-8 string, at most 100,000 bytes |
| `repository` | No | Repository checkout described below |
| `agent` | No | Driver/model/sandbox options |
| `execution` | No | Backend and timeout |
| `source` | No | Provenance; overwritten on the control API |
| `destinations` | No | At most 8 result destinations; deployment default otherwise |
| `metadata` | No | JSON object, at most 32,000 serialized bytes |
| `parentRunId` | No | Opaque lineage value, at most 128 bytes; v1 stores it but does not resume a parent |

### `repository`

```json
{
  "provider": "github",
  "url": "https://github.com/example/repository.git",
  "ref": "feature/ref-or-commit",
  "baseRef": "main",
  "installationId": "123456",
  "credentialSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:agent/github-token-AbCd"
}
```

- `provider` is `github`, `gitlab`, or `generic`.
- `url` must be credential-free HTTPS with no username, password, query, or fragment. Its host must
  be in `ALLOWED_REPOSITORY_HOSTS` (default: `github.com,gitlab.com`).
- `ref` and `baseRef` use a restricted Git-ref syntax; pin automation to an immutable commit when
  reproducibility matters.
- `credentialSecretArn`, when present, is an ARN—not the credential. The worker role must be allowed
  to read only that secret. Prefer deployment-selected credentials for webhook flows over permitting
  arbitrary API callers to select secret ARNs.
- `installationId` is identity metadata. It is not itself proof of installation ownership and does
  not select an AWS secret.

### `agent`

| Field | Values |
| --- | --- |
| `driver` | `codex` or `mock`; `mock` is for tests |
| `model` | Optional deployment/provider model identifier, up to 255 restricted characters |
| `sandbox` | `read-only`, `workspace-write`, or `danger-full-access`, further restricted by deployment policy |
| `reasoningEffort` | `low`, `medium`, `high`, or `xhigh` |
| `outputSchema` | JSON object, at most 32,000 serialized bytes; passed to supported drivers |

Omitted values use deployment defaults. Runtime policy defaults `ALLOWED_SANDBOX_MODES` to
`read-only,workspace-write`, so `danger-full-access` is rejected even though it exists in the v1 enum.
Explicitly enabling it disables the agent CLI's inner sandbox; do so only after reviewing the outer
one-run MicroVM, UID/environment boundary, workload role, egress policy, and repository as
the complete trust boundary.

Codex consumes `model`, `sandbox`, `reasoningEffort`, and `outputSchema`. The mock driver ignores
those controls and returns deterministic output without contacting a model provider.

### `execution`

`backend` must be `microvm`; when omitted, the deployment default is used. `timeoutSeconds` is an
integer from 30 through 28,000 and defaults to 900.

See [Lambda MicroVM execution](architecture.md#lambda-microvm-execution).

### `destinations`

Each entry has `kind` and an optional opaque `route` up to 128 bytes:

- `source`: respond to the trusted originating GitHub/GitLab thread or source chat adapter;
- `teams`: deliver to the default Teams Workflow secret, or to a configured named route;
- `slack`: deliver to the given channel route (or the originating Slack channel);
- `none`: suppress that entry.

If `destinations` is omitted, `DEFAULT_DELIVERY_DESTINATIONS` applies (`source` by default). An API
source has no implicit reply target, so a plain API run with the default `source` destination stores
its result without posting it. Routes are not URLs, tokens, owners, or provider credentials.

## Run response

A newly accepted run resembles:

```json
{
  "runId": "79cc833c-97bf-5a75-ae80-ff80fbaedb3c",
  "ownerId": "api:arn:aws:iam::123456789012:user/operator",
  "ownerCreated": "api:...#2026-08-02T19:12:20.000Z#79cc833c-...",
  "status": "queued",
  "createdAt": "2026-08-02T19:12:20.000Z",
  "updatedAt": "2026-08-02T19:12:20.000Z",
  "expiresAt": 1788299540,
  "requestHash": "<sha256>",
  "input": {
    "bucket": "<artifact-bucket>",
    "key": "owners/<owner-hash>/runs/<run-id>/input-<hash>.json",
    "sha256": "<sha256>"
  },
  "sourceKind": "api",
  "provenance": {
    "actor": {
      "kind": "human",
      "id": "api:arn:aws:iam::123456789012:user/operator",
      "provider": "api"
    },
    "credentialSubject": {
      "kind": "actor",
      "id": "api:arn:aws:iam::123456789012:user/operator"
    }
  }
}
```

`provenance` is host-created, bounded context. A caller cannot submit it as part of the v1 request.
Actor attribution does not grant access to the run or to provider credentials; `ownerId` remains the
authorization and idempotency namespace.

All normal responses include `Cache-Control: no-store`. Submission also includes
`Location: /v1/runs/{runId}`.

Terminal success adds an `execution` reference and a `result` containing S3 references for the full
Markdown output and JSONL events, an optional workspace patch, a 2,000-character preview, exit code,
duration, optional agent thread ID, and token usage. Failure adds:

```json
{
  "error": {
    "code": "agent_failed",
    "message": "bounded diagnostic text",
    "retryable": false
  }
}
```

The artifact route first verifies run ownership, verifies the artifact belongs to the runtime bucket,
and returns a presigned S3 `GET` URL with a deployment-configured 60–900 second lifetime (300 seconds
by default). It does not proxy bytes. Treat the URL as a bearer credential until it expires:

```json
{
  "name": "output",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/...",
  "sha256": "<sha256>",
  "expiresAt": "2026-08-02T19:22:20.000Z"
}
```

Unavailable or unknown artifact names return `409 conflict`. Knowing the bucket/key without a signed
URL or separate S3 permission does not grant access.

## Status and cancellation semantics

| Status | Meaning |
| --- | --- |
| `queued` | Request and record are durable; dispatch is pending |
| `dispatching` | Dispatcher owns start-up; backend ID may be attached shortly |
| `running` | Worker accepted the stored request after its backend ID was durably attached |
| `cancelling` | Stop requested for an active backend |
| `succeeded` | Result artifacts and record committed |
| `failed` | Terminal failure with a bounded error object |
| `cancelled` | Terminal cancellation |

Cancelling `queued` work is immediate. Cancelling `dispatching` or `running` work transitions to
`cancelling` and calls `TerminateMicrovm` once an execution reference is
available. Re-cancelling a `cancelling` run safely repeats the stop when an execution is attached;
terminal cancellation is idempotent. A cancellation cannot undo provider posts,
repository writes, or other external effects already completed.

## Errors

Errors use this envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "prompt cannot be empty"
  }
}
```

Expected mappings are `400 invalid_request`, `403 forbidden`, `404 not_found`, and `409 conflict`.
Unexpected errors return `500 internal_error` with a generic client message; bounded details are sent
to CloudWatch Logs. A `202` from a webhook can also mean an authenticated but unsupported event was
intentionally ignored; see [channels](channels.md).
