# Control API and v1 run contract

The control API is an internal asynchronous API. Submission returns a run record immediately; the
caller polls or consumes the configured completion destination. It does not hold an HTTP connection
open for the agent.

> The current run response projection is the stored `RunRecord`, including owner and S3 artifact
> coordinates. Keep the API behind AWS IAM/JWT authorization and do not expose it directly to an
> untrusted browser client. File-list responses omit S3 coordinates and file-download endpoints
> issue owner-checked, short-lived URLs; a fully public-safe run projection remains a roadmap item.

## Authentication and ownership

Thing discovery and contract documents (`GET /health`, `GET /.well-known/rat-things`,
`GET /openapi.json`, and `GET /schemas/*.json`) are public and contain no owner data. Publication
share redemption uses its own bearer grant. Every other control route requires a principal supplied
by API Gateway:

- an IAM authorizer's `userArn` or `callerId`; or
- a JWT authorizer's `sub` claim.

The handler derives `ownerId` from that value. A caller cannot supply or select its owner. The
`X-Runtime-Owner` escape hatch works only when `ALLOW_OWNER_HEADER=true`; this is for isolated local
testing and must be false in a deployed stack.

The included Terraform module configures `AWS_IAM` on owner-scoped control routes and no
authorization on the discovery/contract routes. JWT principal extraction is a handler capability
for a separately reviewed API Gateway configuration; it is not enabled by the provided root stack.

Runs are readable, listable, and cancellable only by the exact derived owner. Webhook-created runs
use provider-specific owner namespaces and are therefore not automatically visible to an API user.
Cross-identity lookup is an administrative capability outside v1.

## Routes

| Method and path | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | None | Liveness response; does not prove worker/model/provider readiness |
| `GET /.well-known/rat-things` | None | Deployment capabilities plus relative OpenAPI and schema links |
| `GET /openapi.json` | None | OpenAPI 3.1 contract for headless consumers |
| `GET /schemas/thing-v1.json` | None | Portable ThingSpec v1 JSON Schema |
| `GET /schemas/thing-create-v1.json` | None | Create-Thing envelope JSON Schema |
| `GET /schemas/thing-version-v1.json` | None | Immutable-version envelope JSON Schema |
| `GET /v1/capability-profiles` | Required | List installed capability-policy ceilings |
| `GET /v1/integrations/plugins` | Required | List trusted integration manifests and operation schemas |
| `GET /v1/integrations/connections` | Required | List the owner's connections and persistent grants; never returns credentials |
| `POST /v1/integrations/connections` | Required | Verify one provider credential, derive account metadata, then create its secret and initial grant |
| `POST /v1/integrations/connections/{connectionId}/grant` | Required | Replace the account's persistent Rat-side grant |
| `POST /v1/integrations/connections/{connectionId}/credential` | Required | Verify and rotate a credential without changing provider account identity |
| `POST /v1/integrations/connections/{connectionId}/revoke` | Required | Revoke the connection and its credential |
| `GET /v1/integrations/connection-sets` | Required | List reusable multi-account connection sets |
| `POST /v1/integrations/connection-sets` | Required | Create a reusable multi-account connection set |
| `GET /v1/integrations/source-bindings` | Required | List verified-source capability bindings |
| `POST /v1/integrations/source-bindings` | Required | Bind a verified source selector to a profile and/or connection set |
| `GET /v1/things?limit=25&nextToken=...` | Required | List owner-scoped Thing summaries; `includeArchived=true` includes archived entries |
| `POST /v1/things` | Required | Create a draft or enabled Thing and immutable revision 1 |
| `GET /v1/things/{thingId}` | Required | Get the current complete Thing definition |
| `GET /v1/things/{thingId}/versions` | Required | List immutable version metadata |
| `GET /v1/things/{thingId}/versions/{revision}` | Required | Get one historical immutable definition |
| `POST /v1/things/{thingId}/versions` | Required | Select a new immutable revision using `expectedRevision` compare-and-swap |
| `GET /v1/things/{thingId}/explain` | Required | Resolve effective profile, accounts, grants, operations, and diagnostics without credentials |
| `POST /v1/things/{thingId}/run` | Required | Test/explicitly invoke a non-archived Thing and return `202` |
| `POST /v1/things/{thingId}/enable` | Required | Mark enabled and activate interval scheduling; explicit manual runs also work in draft/paused |
| `POST /v1/things/{thingId}/pause` | Required | Stop scheduled occurrences while retaining explicit test runs |
| `POST /v1/things/{thingId}/archive` | Required | Terminally archive a Thing |
| `GET /v1/routines?limit=25&nextToken=...` | Required | List owner-scoped interval routines |
| `POST /v1/routines` | Required | Store a versioned routine and its encrypted run request |
| `GET /v1/routines/{routineId}` | Required | Get one non-deleted routine |
| `POST /v1/routines/{routineId}/run` | Required | Submit the stored request immediately and return `202` |
| `POST /v1/routines/{routineId}/pause` | Required | Pause future scheduled occurrences |
| `POST /v1/routines/{routineId}/resume` | Required | Resume at the retained or next future occurrence |
| `POST /v1/routines/{routineId}/delete` | Required | Soft-delete a routine; metadata expires after 30 days |
| `POST /v1/conversations/{conversationId}/messages` | Required | Append one owner-scoped durable conversation turn and return `202` |
| `GET /v1/conversations/{conversationId}/messages/{messageId}` | Required | Poll the exact message, bound run, conversation, and suspended-session state |
| `GET /v1/conversations/{conversationId}/artifacts` | Required | List the current durable files for an owner-scoped conversation |
| `GET /v1/conversations/{conversationId}/artifacts/{artifact}` | Required | Return a fresh short-lived view/download URL for a conversation file |
| `POST /v1/conversations/{conversationId}/publications` | Required | Build and share a file, site, or video from the current conversation catalog |
| `POST /v1/runs` | Required | Validate, durably store, enqueue, and return `202` |
| `GET /v1/runs?limit=25&nextToken=...` | Required | Newest-first runs for the current owner; limit is clamped to 1–100 |
| `GET /v1/runs/{runId}` | Required | Current record for the current owner |
| `GET /v1/runs/{runId}/events?after=0&limit=100` | Required | Poll ordered App Server events plus outstanding server requests for an active run |
| `POST /v1/runs/{runId}/steer` | Required | Add text to the active turn |
| `POST /v1/runs/{runId}/interrupt` | Required | Interrupt the active turn without selecting a MicroVM directly |
| `POST /v1/runs/{runId}/approvals/{requestId}` | Required | Accept, accept for the session, decline, or cancel an approval request |
| `POST /v1/runs/{runId}/requests/{requestId}/respond` | Required | Return an arbitrary JSON result for another App Server request |
| `GET /v1/runs/{runId}/artifacts` | Required | List user-visible files captured by the run |
| `GET /v1/runs/{runId}/artifacts/{name}` | Required | Owner-checked URL for a generated-file ID or `input`, `output`, `events`, or `patch` |
| `POST /v1/runs/{runId}/publications` | Required | Build and share a file, site, or video from a successful run's catalog |
| `GET /__share/{token}` | Bearer token | Redeem a publication grant for host-only CloudFront signed cookies |
| `GET /v1/shares/{token}` | Bearer token | Validate a time-bounded file share and redirect to private S3 |
| `POST /v1/runs/{runId}/cancel` | Required | Request cancellation and return `202`; terminal runs are unchanged |
| `POST /webhooks/github` | Provider signature | Optional GitHub event ingress; verifies the raw body before normalization |
| `POST /webhooks/gitlab` | Provider signature | Optional GitLab event ingress with signed-standard and legacy verification |
| `POST /webhooks/teams` | Provider signature | Optional Teams activity ingress with immediate acknowledgement |
| `POST /webhooks/slack` | Provider signature | Optional Slack event ingress with timestamp/replay checks |

`nextToken` is opaque and must be returned unchanged. Live events use an ordered polling snapshot,
not a long-held HTTP stream. Interactive routes are available only while the exact run has an active
MicroVM execution; stale, terminal, or non-interactive runs return `409`. Callers never select a
MicroVM or receive its AWS-issued proxy token. Durable conversation continuation remains trusted
orchestration selected from the stored owner-scoped session.

## Integration connection contract

`GET /v1/integrations/plugins` is the form and tool-generation contract. Each manifest declares one
or more authentication schemes with exact credential fields, plus typed operations with access,
risk, approval, scope, and input-schema metadata.

Connection creation accepts only:

```json
{
  "version": "1",
  "pluginId": "stripe",
  "authScheme": "api-key",
  "credential": { "api_key": "..." },
  "grant": { "version": "1", "preset": "read-only" }
}
```

`alias` is the only optional setup field. The server verifies the credential before creating a
secret and derives the label, provider tenant/subject, access, and scopes. Callers cannot submit
those claims or an owner ID. A verification failure is `400 invalid_request` and creates no
connection; provider throttling, 5xx, or network failure is retryable `503 integration_unavailable`.
Repeating the request with another credential creates another independently permissioned account for
the same plugin.

The CLI implements this contract as
`rat-things connect PLUGIN --credential-file FILE [--auth-scheme SCHEME] [--access PRESET]`.
Credential rotation uses `rat-things rotate ACCOUNT --credential-file FILE`; the server verifies
that the new credential resolves to the same provider tenant/subject before replacing it. See the
[complete Integration Contract v1](plugins.md#the-integration-contract-v1).

## Discovery and error contract

Consumers should fetch `/.well-known/rat-things` from the deployment instead of assuming a central
runtime URL. Its links are relative so custom domains and reverse proxies remain independent. The
same OpenAPI and JSON Schema files are published with the documentation for generation and CI, but
an installed deployment is authoritative for the capabilities it advertises.

Errors use a stable envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Thing spec trigger.kind must be manual or interval",
    "retryable": false,
    "traceId": "API_GATEWAY_REQUEST_ID"
  }
}
```

Preserve `traceId` when reporting an issue. `invalid_request`, `forbidden`, `not_found`, and
`conflict` are not retryable without changing state or input. Unexpected internal failures hide
their details from the caller and set `retryable: true`; use bounded structured logs for diagnosis.

## Things

Things are the recommended facade for new operator and embedded-product consumers. A Thing compiles
to the existing run request while hiding routine storage and scheduler details. Definitions are
immutable, content-digested objects in a private encrypted non-expiring definition bucket;
DynamoDB stores lifecycle and references only. Every occurrence adds trusted Thing provenance and
still passes through ordinary run validation, capability profiles, connection grants, approval
policy, and idempotent queue submission.

See [Things](things.md) for the complete contract, lifecycle, multi-account example, CLI mapping,
and `explain` output. Raw runs and routines remain supported lower-level interfaces.

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
    "sandbox": "danger-full-access",
    "reasoningEffort": "low",
    "capabilities": {
      "profile": "small-business",
      "computerUse": "browser"
    }
  },
  "integrations": {
    "connections": [
      { "connection": "slack-shop", "preset": "read-only" },
      { "connection": "stripe-shop", "preset": "read-write" }
    ]
  }
}
```

Only `version`, `prompt`, `agent`, and `integrations` are accepted. Durable conversations support
the normal agent fields except `outputSchema`, plus the multi-account integration selection
described below. A conversation's execution and integration policies are fixed by its first message;
later attempts to change them return `409`. Callers cannot submit a provider source, destination,
repository credential, output schema, MicroVM ID, Codex thread ID, or auth mode through this route.

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

## Live App Server interaction

The runner uses the bidirectional Codex App Server protocol, not `codex exec`. Every notification is
assigned an in-memory sequence and can be polled while the run is active:

```bash
rat-things watch RUN_ID --follow
rat-things steer RUN_ID "Use the newly uploaded specification"
rat-things approve RUN_ID REQUEST_ID --decision accept-for-session
rat-things respond RUN_ID REQUEST_ID --result '{"answers":{"region":"us-west-2"}}'
rat-things interrupt RUN_ID
```

`GET .../events` returns
`{runId,active,ready,oldestSequence,nextSequence,events,pendingRequests,turn}`. Pass the last seen
`sequence` back as `after`; results are ordered and bounded to 100. If a client falls behind
`oldestSequence`, it missed entries from the bounded ring and must rely on the terminal JSONL event
artifact. `pendingRequests` includes
Codex command/file approvals, dynamic integration approvals, browser-interaction approvals, and any
other server request awaiting a JSON result. Approval decisions are `accept`,
`accept-for-session`, `decline`, and `cancel`.

This is a live control plane, not the durable event archive. The complete JSONL event artifact is
written to encrypted S3 after the turn, while the live in-MicroVM ring is bounded and disappears
when the execution ends. API Gateway authenticates the owner, then trusted control orchestration
mints a short-lived proxy token for the exact MicroVM and port 8080; that endpoint and token never
reach the caller or agent child.

## Routines

A routine stores one validated run request and submits it on an interval. DynamoDB keeps only the
schedule, status, hash, and encrypted S3 reference; prompt and integration selections stay in the
artifact plane.

```http
POST /v1/routines HTTP/1.1
Content-Type: application/json

{
  "version": "1",
  "name": "Customer operations review",
  "schedule": {
    "kind": "interval",
    "everyMinutes": 60,
    "startAt": "2026-08-21T09:00:00-07:00"
  },
  "enabled": true,
  "request": {
    "version": "1",
    "prompt": "Review new customer messages and payment exceptions.",
    "agent": {
      "capabilities": { "profile": "small-business" }
    },
    "integrations": {
      "connectionSet": "customer-ops"
    },
    "destinations": [
      { "kind": "slack", "route": "C01234567" }
    ]
  }
}
```

`everyMinutes` is an integer from 1 through 525,600. `startAt` is optional and must be an ISO
date-time with a timezone. When omitted, the first occurrence is one interval after creation.
Paused routines retain the next future occurrence; resuming after it has passed advances to the next
future interval. The one-minute reconciler skips accumulated backlog rather than launching a storm.

Scheduled submissions use `routine:<routineId>:<scheduledAt>` idempotency, so a reconciler retry
cannot create a second semantic occurrence. The schedule advances only after submission succeeds.
`POST .../run` performs a separate immediate submission and accepts an optional `Idempotency-Key`.
Retries with the same manual key derive the same occurrence ID; the resulting run's `createdAt`
records when that manual execution was first accepted.

Routine requests cannot set `source`, `parentRunId`, a `source` delivery destination, or reserved
routine metadata. At execution, trusted orchestration rechecks the owner-scoped S3 key and canonical
request digest, adds system provenance and schedule metadata, and submits through the ordinary run
service. Routines do not bypass account grants or capability profiles. Use an approval-free profile
and tightly bounded grants for intentionally unattended side effects.

## Durable files

`.rat-things/artifacts/` is the agent-facing outbox and durable working directory. On every
successful run, the trusted runner validates its regular files, computes their SHA-256 hashes,
renews their private S3 objects, and records the complete current catalog. For conversations, that
catalog is committed alongside the completed turn and restored before the next turn. The artifact
bucket is therefore authoritative even if the prior MicroVM and its mounted workspace are
unavailable.

The limits are 5,000 files, 5 GiB per file, 20 GiB total, an 8 MiB catalog, and 512 UTF-8 bytes per
relative path. Symlinks, hard links, special files, control characters, absolute paths, and
traversal are rejected. Upload and restore are streamed; retained files whose digest is unchanged
are renewed with an S3 server-side copy. Common image, audio, video, PDF, text, web-font, manifest,
and WebAssembly formats receive browser-correct media types; unknown formats are downloads.

```bash
rat-things --thread release-smoke --sandbox workspace-write \
  "Save the rendered report as .rat-things/artifacts/report.pdf"

rat-things files --thread release-smoke
rat-things file report.pdf --thread release-smoke
rat-things file report.pdf --thread release-smoke --download ./report.pdf
rat-things publish file report.pdf --thread release-smoke
```

`files --json` returns metadata without S3 bucket or key coordinates. `file` accepts a catalog ID,
relative path, or unique basename and prints a fresh URL unless `--download` is supplied. For
one-shot automation, use `--run RUN_ID` instead of `--thread NAME`. The complete human and agent
workflow is documented in [Durable files and share links](durable-files.md). The common file, site,
and video delivery model is documented in [publications](publications.md).

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
    "sandbox": "danger-full-access",
    "reasoningEffort": "high",
    "reasoningSummary": "concise",
    "personality": "pragmatic",
    "capabilities": {
      "profile": "small-business",
      "approvalPolicy": "on-request",
      "networkAccess": true,
      "webSearch": "live",
      "computerUse": "browser",
      "skills": ["security-review"],
      "apps": ["github"],
      "mcpServers": ["company-docs"]
    }
  },
  "integrations": {
    "connections": [
      { "connection": "github-consulting", "preset": "read-only" }
    ]
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
| `agent` | No | Driver, model, reasoning, sandbox, and capability options |
| `integrations` | No | Owner-scoped connection set and/or individual multi-account selections |
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
| `reasoningEffort` | `low`, `medium`, `high`, `xhigh`, or `ultra` |
| `reasoningSummary` | `auto`, `concise`, `detailed`, or `none` |
| `personality` | `none`, `friendly`, or `pragmatic` |
| `capabilities` | Profile plus approval, network, search, browser, skill, app, and MCP selections |
| `outputSchema` | JSON object, at most 32,000 serialized bytes; passed to supported drivers |

Remote MicroVM execution defaults to `danger-full-access` with agent command networking enabled.
The outer one-run/one-conversation MicroVM, unprivileged agent UID, stripped AWS environment, scoped
workload role, and connection broker are the primary isolation boundary. `ALLOWED_SANDBOX_MODES`
remains the deployment ceiling, while requests and profiles can select a narrower inner Codex
sandbox. Trusted local `rat-things local` runs deliberately retain a read-only/no-network default.

Codex consumes the agent controls and registers selected App Server features. The mock driver
ignores them and returns deterministic output without contacting a model provider.

### `agent.capabilities`

| Field | Values and behavior |
| --- | --- |
| `profile` | Installed profile ID: currently `read-only`, `small-business`, or `microvm-full` |
| `approvalPolicy` | `untrusted`, `on-request`, or `never`; a request cannot relax its profile |
| `approvalsReviewer` | `user`, `auto-review`, or `guardian-subagent` |
| `networkAccess` | Boolean command-network selection, capped by the profile |
| `webSearch` | `disabled`, `cached`, `indexed`, or `live`, capped by the profile |
| `computerUse` | `disabled` or `browser`; browser requires network access |
| `skills` | Non-empty list of installed Codex skill names; unavailable/disabled names fail the turn |
| `apps` | Non-empty list forwarded to Codex as the requested app selection |
| `mcpServers` | Non-empty list of configured MCP server names to force-enable for the thread |

`skills` are resolved with App Server `skills/list` and added to the turn as skill inputs. Apps and
MCP servers are passed through the current App Server configuration surface. MCP selection enables
the named servers but is not an exact deny-list for additional servers inherited from a project
configuration; keep the MicroVM base configuration empty when exact deployment control matters.

The `small-business` profile allows browser use and up to read-write integrations while retaining
on-request approval. `microvm-full` permits full integrations and automatic browser interaction.
Because Codex's `danger-full-access` policy has no independent command-network switch, explicitly
setting `networkAccess: false` automatically narrows the effective inner sandbox to
`workspace-write`; the outer MicroVM remains the isolation boundary.
Use the latter only for intentionally unattended work whose external side effects are already
bounded by connection grants.

See [browser computer use](browser-computer-use.md) for the implemented command surface, live-AWS
evidence, safety boundaries, and the capabilities still required before making an unqualified
“full computer use” claim.

### `integrations`

`connectionSet` selects a reusable owner-scoped set. `connections` selects up to 32 aliases or IDs;
each entry can add a `read-only`, `read-write`, `full`, or `custom` per-run ceiling plus operation
allow/deny lists. When both are present their connection selections are merged, and all applicable
provider authorization, persistent grant, profile, and run constraints are intersected. Credentials,
grant IDs, provider scopes, approval overrides, resource constraints, and secret references are not
accepted in a run request. See [integrations and permissions](plugins.md).

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
Markdown output and JSONL events, an optional workspace patch, a complete user-visible file
catalog, a 2,000-character preview, exit code, duration, optional agent thread ID, and token usage.
Failure adds:

```json
{
  "error": {
    "code": "agent_failed",
    "message": "bounded diagnostic text",
    "retryable": false
  }
}
```

An artifact URL route first verifies run or conversation ownership, verifies the object belongs to
the runtime bucket, and creates an opaque bearer URL with a deployment-configured 60–86,400 second
lifetime (86,400 seconds by default). With publication delivery enabled, the URL is on an isolated
publication subdomain; redemption redirects to a signed browser-ready `index.html` and installs
equivalent CloudFront cookies for its subresources. The signed first page does not depend on a
browser preserving cookies through the redirect. Grant expiry is independent of the control Lambda's rotating role credentials, and
CloudFront reads bytes from private S3 through Origin Access Control. Deployments without the
publication domain retain the compatibility path, which redirects each access to a fresh one-minute
S3 `GET` URL. Treat either URL as a bearer credential until it expires:

```json
{
  "id": "<artifact-id>",
  "path": "pelican-bicycle.webp",
  "mediaType": "image/webp",
  "bytes": 31286,
  "url": "https://<publication>.<share-domain>/__share/<token>",
  "sha256": "<sha256>",
  "expiresAt": "2026-08-02T19:22:20.000Z"
}
```

Explicit publication requests accept the versioned tagged bodies shown in
[publications](publications.md#control-api). Unavailable or unknown artifact names return `409
conflict`. Knowing the bucket/key without a grant or separate S3 permission does not grant access.

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
