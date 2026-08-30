# Control API reference

The control API is the asynchronous backend contract shared by the CLI, operator tools, embedded
products, other agents, and authenticated event adapters. Every accepted execution returns one Run
receipt immediately: Thing tests/runs, schedules, routine runs, raw calls, signed provider events,
and threaded calls all use the same durable object and lifecycle. A thread adds continuity
preparation behind that receipt; it does not create a mailbox receipt first and a Run later. The
caller follows events, polls, or consumes the configured completion destination. The API does not
hold an HTTP connection open for the agent.

New consumers should begin with the [operating model](operating-model.md), then use this page for
route-level behavior. The deployment's `/openapi.json` is authoritative for generated clients and
installed routes.

> Run responses are a deliberately smaller projection of the stored `RunRecord`. They omit owner
> keys, object-store coordinates, execution handles, conversation bindings, agent thread IDs, and
> provenance. File-list responses also omit S3 coordinates, while file-download endpoints issue
> owner-checked, short-lived URLs. The API still requires its documented authentication and is not
> an unauthenticated public data surface.

## Authentication and ownership

Thing discovery and contract documents (`GET /health`, `GET /.well-known/rat-things`,
`GET /openapi.json`, and `GET /schemas/*.json`) are public and contain no owner data. Publication
share redemption uses its own bearer grant. Every other published v1 control route requires an IAM
principal supplied by API Gateway through its `userArn` or `callerId`.

The handler derives `ownerId` from that value. A caller cannot supply or select its owner. The
`X-Runtime-Owner` escape hatch works only when `ALLOW_OWNER_HEADER=true`; this is for isolated local
testing and must be false in a deployed stack.

The included Terraform module configures `AWS_IAM` on owner-scoped control routes and no
authorization on the discovery/contract routes. The handler contains a JWT `sub` extraction hook
for a separately maintained transport adapter, but v1 discovery/OpenAPI does not advertise bearer
authentication; it is not a supported direct-client surface in the provided stack.

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
| `GET /schemas/thing-create-v1.json` | None | Create alias for the direct ThingSpec schema |
| `GET /schemas/thing-version-v1.json` | None | Immutable-version envelope JSON Schema |
| `GET /v1/capability-profiles` | Required | List installed capability-policy ceilings |
| `GET /v1/integrations/plugins` | Required | List trusted integration manifests and operation schemas |
| `POST /v1/integrations/oauth/authorizations` | Required | Create a ten-minute owner-bound OAuth state and PKCE authorization URL from one configured plugin |
| `GET /v1/integrations/oauth/callback` | None | Provider redirect target; atomically consumes state, exchanges/verifies the code, and stores the credential |
| `GET /v1/integrations/connections` | Required | List the owner's connections, persistent grants, and bounded health; never returns credentials |
| `POST /v1/integrations/connections` | Required | Verify one provider credential, derive account metadata, then create its secret and initial grant |
| `GET /v1/integrations/connections/{connectionId}` | Required | Get one connection, grant, and bounded health by ID or stable alias |
| `PATCH /v1/integrations/connections/{connectionId}` | Required | Change the display name without changing the stable alias or provider identity |
| `POST /v1/integrations/connections/{connectionId}/test` | Required | Host-side credential verification that returns bounded health and never exposes the credential |
| `GET /v1/integrations/connections/{connectionId}/consumers` | Required | Derive owner-scoped Things, routines, sets, and source bindings that select this account |
| `POST /v1/integrations/connections/{connectionId}/grant` | Required | Replace the account's persistent Rat-side grant |
| `POST /v1/integrations/connections/{connectionId}/credential` | Required | Verify and rotate a credential without changing provider account identity |
| `POST /v1/integrations/connections/{connectionId}/oauth/reconnect` | Required | Start a short-lived OAuth reconnect bound to the existing connection, grant, and verified provider identity |
| `POST /v1/integrations/connections/{connectionId}/revoke` | Required | Revoke the connection and its credential |
| `GET /v1/integrations/connection-sets` | Required | List reusable multi-account connection sets |
| `POST /v1/integrations/connection-sets` | Required | Create a reusable multi-account connection set |
| `GET /v1/integrations/source-bindings` | Required | List verified-source capability bindings |
| `POST /v1/integrations/source-bindings` | Required | Bind a verified source selector to a profile and/or connection set |
| `GET /v1/things?limit=25&nextToken=...` | Required | List owner-scoped Thing summaries; `includeArchived=true` includes archived entries |
| `POST /v1/things` | Required | Create draft revision 1 directly from a ThingSpec |
| `GET /v1/things/{thingId}` | Required | Get explicit draft and active pointers with complete definitions |
| `GET /v1/things/{thingId}/versions` | Required | List immutable version metadata |
| `GET /v1/things/{thingId}/versions/{revision}` | Required | Get one historical immutable definition |
| `POST /v1/things/{thingId}/versions` | Required | Append a draft revision using `expectedDraftRevision` compare-and-swap |
| `GET /v1/things/{thingId}/explain?target=draft\|active` | Required | Resolve one exact revision's profile, accounts, operations, trigger health, and diagnostics |
| `POST /v1/things/{thingId}/test` | Required | Invoke the latest draft without publishing it and return `202` |
| `POST /v1/things/{thingId}/publish` | Required | Verify one successful exact-draft test Run, pin that unchanged draft as active, and synchronize its EventBridge Scheduler trigger |
| `POST /v1/things/{thingId}/run` | Required | Explicitly invoke the active revision and return `202` |
| `POST /v1/things/{thingId}/pause` | Required | Disable scheduled occurrences while retaining explicit active runs and draft tests |
| `POST /v1/things/{thingId}/resume` | Required | Re-synchronize and enable the active schedule |
| `POST /v1/things/{thingId}/archive` | Required | Terminally archive a Thing and remove its schedule |
| `GET /v1/routines?limit=25&nextToken=...` | Required | List owner-scoped interval routines |
| `POST /v1/routines` | Required | Store a versioned routine and its encrypted run request |
| `GET /v1/routines/{routineId}` | Required | Get one non-deleted routine |
| `POST /v1/routines/{routineId}/run` | Required | Submit the stored request immediately and return `202` |
| `POST /v1/routines/{routineId}/pause` | Required | Pause future scheduled occurrences |
| `POST /v1/routines/{routineId}/resume` | Required | Resume at the retained or next future occurrence |
| `POST /v1/routines/{routineId}/delete` | Required | Soft-delete a routine; metadata expires after 30 days |
| `GET /v1/conversations?limit=25&nextToken=...&visibility=visible` | Required | List owner-scoped durable conversation summaries with opaque IDs and durable pin/hide/read state |
| `GET /v1/conversations/search?q=...&limit=20` | Required | Search indexed user/assistant messages and artifact paths across the owner's visible and hidden conversations |
| `GET /v1/conversations/{opaqueConversationId}?limit=50&nextToken=...` | Required | Read safe conversation state and one cursor-paged durable transcript window |
| `POST /v1/conversations/{opaqueConversationId}/organization` | Required | Set owner-scoped `pinned`, `hidden`, or `read` booleans without changing execution authority or lifecycle |
| `POST /v1/conversations/{opaqueConversationId}/messages/{messageId}/reactions` | Required | Add or remove one supported durable owner reaction without starting a Run |
| `GET /v1/conversations/{conversationId}/messages/{messageId}` | Required | Poll the exact message, bound run, conversation, and suspended-session state |
| `GET /v1/conversations/{conversationId}/artifacts` | Required | List durable files using an API thread key or the opaque public conversation ID |
| `GET /v1/conversations/{conversationId}/artifacts/{artifact}` | Required | Return a fresh short-lived view/download URL using either conversation selector |
| `GET /v1/conversations/{conversationId}/artifacts/{artifact}/content` | Required | Owner-check either selector and redirect an inline viewer to short-lived private content |
| `POST /v1/conversations/{conversationId}/publications` | Required | Build and share a file, site, or video from the current conversation catalog |
| `POST /v1/runs` | Required | Validate, durably store, and return the universal Run receipt (`202`); optional `thread` adds owner-scoped continuity preparation |
| `GET /v1/runs?limit=25&nextToken=...` | Required | Newest-first runs for the current owner; limit is clamped to 1–100 |
| `GET /v1/runs/{runId}` | Required | Current record for the current owner |
| `GET /v1/runs/{runId}/events?after=0&limit=100` | Required | Poll ordered typed activity cards plus outstanding ordinary input requests for an active run |
| `POST /v1/runs/{runId}/steer` | Required | Add text to the active turn |
| `POST /v1/runs/{runId}/interrupt` | Required | Interrupt the active turn without selecting a MicroVM directly |
| `POST /v1/runs/{runId}/requests/{requestId}/respond` | Required | Return JSON data for an ordinary App Server input request; cannot widen authority |
| `GET /v1/runs/{runId}/artifacts` | Required | List user-visible files captured by the run |
| `GET /v1/runs/{runId}/artifacts/{name}` | Required | Owner-checked URL for a generated-file ID or `input`, `output`, `events`, or `patch` |
| `POST /v1/runs/{runId}/publications` | Required | Build and share a file, site, or video from a successful run's catalog |
| `GET /__share/{token}` | Bearer token | Redeem a publication grant for host-only CloudFront signed cookies |
| `POST /v1/runs/{runId}/cancel` | Required | Request cancellation and return `202`; terminal runs are unchanged |
| `POST /webhooks/github` | Provider signature | Optional GitHub event ingress; verifies the raw body before normalization |
| `POST /webhooks/gitlab` | Provider signature | Optional GitLab event ingress with signed-standard and legacy verification |
| `POST /webhooks/teams` | Provider signature | Optional Teams activity ingress with immediate acknowledgement |
| `POST /webhooks/slack` | Provider signature | Optional Slack event ingress with timestamp/replay checks |

`nextToken` is opaque and must be returned unchanged. Live events use an ordered polling snapshot,
not a long-held HTTP stream. Live-control routes are available only while the exact run has an active
MicroVM execution; stale, terminal, or non-interactive runs return `409`. Callers never select a
MicroVM or receive its AWS-issued proxy token. Durable conversation continuation remains trusted
orchestration selected from the stored owner-scoped session.

Every authenticated control-route success body is typed in `/openapi.json`. Every execution-starting
`202` response includes a Run receipt and `Location: /v1/runs/{runId}`. Non-execution actions such as
cancellation retain their separately documented action receipts.
Thing test/run receipts additionally include
`thing: {version, thingId, revision, specHash, invocation}` so a caller can prove which immutable
revision produced the run before moving the active pointer.

## Integration connection contract

`GET /v1/integrations/plugins` is the form and tool-generation contract. Each manifest declares one
or more authentication schemes with exact credential fields, plus typed operations with access,
risk, required provider scopes, and input-schema metadata.

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

Connection and Thing creation do not accept an idempotency key in v1. If the HTTP response is lost,
list owner-visible state and reconcile provider-derived identity or Thing `specHash` before
retrying; do not blindly create a duplicate. Run invocation and conversation messages have explicit
idempotency controls.

The CLI implements the manual contract as
`rat-things connect PLUGIN --credential-file FILE [--auth-scheme SCHEME] [--access PRESET]` and
configured self-hosted OAuth as
`rat-things connect PLUGIN --oauth [--wait] [--no-browser] [--access PRESET]`. `--wait`
keeps the CLI attached until the callback installs and verifies the new connection; without it,
the CLI returns the short-lived authorization URL immediately.
Credential rotation uses `rat-things rotate ACCOUNT --credential-file FILE`. The unified management
form is `rat-things connection reconnect ACCOUNT --credential-file FILE` for manual credentials or
`rat-things connection reconnect ACCOUNT --oauth [--wait] [--no-browser]` for OAuth. The server
preserves the connection ID, alias, grant, and consumers, and verifies that the replacement resolves
to the same provider tenant/subject before replacing it. See the
[complete Integration Contract v1](plugins.md#the-integration-contract-v1).

Connection operations have direct CLI parity:
`rat-things connection show ACCOUNT`, `connection test ACCOUNT`,
`connection consumers ACCOUNT`, `connection rename ACCOUNT --name NAME`, and
`connection reconnect ACCOUNT`. `test` runs only in
the authenticated host control plane, may refresh an expiring OAuth record through the trusted
broker, and persists only status/code/timestamps. It is not available to an agent as a dynamic
tool. `consumers` reads owner-scoped definitions without opening the credential vault.
The AWS reference deployment also checks a rotating, bounded slice of stale connections on a
schedule. That job has its own narrow IAM role and stores only the same bounded health projection.

For the built-in Slack channel bridge,
`rat-things slack-events ACCOUNT [--profile read-only] [--json]` derives the team selector from the
verified Connection, creates or reuses the owner Connection Set/source binding, and rejects a second
Connection that attempts to route mentions for the same workspace. The command's output is JSON;
`--json` is accepted for consistency with other machine-oriented CLI commands.

## Discovery and error contract

Consumers should fetch `/.well-known/rat-things` from the deployment instead of assuming a central
runtime URL. Its links are relative so custom domains and reverse proxies remain independent. The
same OpenAPI and JSON Schema files are published with the documentation for generation and CI, but
an installed deployment is authoritative for the capabilities it advertises.

The response also links the focused agent guide, compact `llms.txt` navigation, and optional
operational agent corpus. Agents should read the guide and progressively follow the installed
contracts; they should not load that broad corpus or guess every operation for a simple Thing run. See
[Connect an agent to Rat Things](agents.md).

Installed JSON Schemas use relative `$id` values, so relative references resolve against the exact
deployment that served them rather than silently switching to the central documentation copy.
Schema `maxLength` is character-based preflight; runtime UTF-8 byte limits remain authoritative.

Errors use a stable envelope:

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

Preserve `traceId` when reporting an issue. `invalid_request`, `forbidden`, `not_found`, and
`conflict` are not retryable without changing state or input. Unexpected internal failures hide
their details from the caller and set `retryable: true`; use bounded structured logs for diagnosis.

## Things

Things are the recommended facade for new operator and embedded-product consumers. A stable Thing
has separate `draft` and `active` pointers into immutable, content-digested revisions. Testing always
uses the draft; production invocation and Amazon EventBridge Scheduler always use the pinned active
revision. DynamoDB stores lifecycle and references while complete definitions stay in a private,
encrypted, non-expiring definition bucket. Every occurrence adds trusted Thing provenance and still
passes through ordinary run validation, fixed capability-envelope resolution, connection grants,
and idempotent queue submission. The complete lifecycle and schedule contract is in
[Things](things.md).

See [Things](things.md) for the complete contract, lifecycle, multi-account example, CLI mapping,
and `explain` output. Raw runs and routines remain supported lower-level interfaces.

## Headless durable conversations

Headless continuity is an option on the universal Run submission, not a second submission API. Add
`thread.key` to `POST /v1/runs`. Rat commits that exact Run first, then uses the durable mailbox and
coordinator to prepare replay context before dispatch. Provider threads enter the same service after
signature verification and normalization.

`thread.key` is a caller-visible value containing 1–128 letters, digits, `.`, `_`, `:`, or `-`,
starting with a letter or digit. Rat hashes the authenticated owner into the internal conversation
ID, so two principals using `release-smoke` do not share state. `Idempotency-Key` is required for a
threaded submission and is also the message identity. Repeating the same key and request returns the
same Run; reusing it for different content or thread state returns `409 conflict`.

`thread.replyToMessageId` creates an immutable reply edge to a public transcript message. Optional
`thread.attachments` accepts at most six base64 files, 4 MiB per file and 6 MiB decoded total. The
adapter verifies an optional SHA-256, writes the bytes and a private manifest to encrypted S3, and
strips the transport representation before execution. The coordinator merges those files into the
ordinary durable conversation catalog under its lease, so the agent sees them below
`.rat-things/artifacts/uploads/` and replacement MicroVMs restore them through the existing path.
Attachment names, media types, sizes, and checksums are part of threaded idempotency.

```http
POST /v1/runs HTTP/1.1
Content-Type: application/json
Idempotency-Key: 93811d8e-2368-4ff8-9e93-706d344e5c8e

{
  "version": "1",
  "prompt": "Use the shell tool to run pwd and report the result.",
  "thread": { "key": "release-smoke" },
  "agent": {
    "driver": "codex",
    "sandbox": "danger-full-access",
    "reasoningEffort": "low",
    "capabilities": {
      "profile": "small-business",
      "computerUse": "browser",
      "networkAccess": true
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

The response is the same public queued Run returned for a one-shot request, with
`Location: /v1/runs/{runId}`. Trusted orchestration binds it to the conversation internally, but the
public Run projection exposes neither that binding nor its owner/storage coordinates. There is never
a second public Run for the accepted input:

```json
{
  "runId": "...",
  "status": "queued",
  "sourceKind": "api",
  "createdAt": "2026-08-25T18:00:00.000Z",
  "updatedAt": "2026-08-25T18:00:00.000Z",
  "expiresAt": 1798231200
}
```

Poll the Run location for execution state. When a consumer also needs proof that completion has been
folded into durable thread context and the MicroVM is suspended, poll
`GET /v1/conversations/release-smoke/messages/93811d8e-...`. That deep status surface returns the
same bound Run plus mailbox/session state:

```json
{
  "conversationId": "release-smoke",
  "messageId": "93811d8e-2368-4ff8-9e93-706d344e5c8e",
  "state": "consumed",
  "delivery": "defer",
  "createdAt": "2026-08-25T18:00:00.000Z",
  "consumedAt": "2026-08-25T18:01:04.000Z",
  "conversation": {
    "status": "idle",
    "pendingCount": 0,
    "createdAt": "2026-08-25T18:00:00.000Z",
    "updatedAt": "2026-08-25T18:01:04.000Z",
    "session": {
      "backend": "microvm",
      "state": "suspended",
      "updatedAt": "2026-08-25T18:01:04.000Z",
      "expiresAt": "2026-08-25T18:31:04.000Z"
    }
  },
  "run": {
    "runId": "...",
    "status": "succeeded",
    "sourceKind": "api",
    "createdAt": "2026-08-25T18:00:00.000Z",
    "updatedAt": "2026-08-25T18:01:03.000Z",
    "expiresAt": 1798231200
  }
}
```

The bundled CLI performs Run submission, polling, completion/suspension checks, artifact download,
conversation list/search/paging and organization, attachment preparation, replies, reactions,
source collection, and SigV4 signing. With `--json`, retain the public message and Run IDs,
timestamps, Run state, and
suspended-session state; private MicroVM and native Codex thread identifiers are intentionally
omitted:

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

rat-things conversations search "marker.txt"
rat-things conversation show PUBLIC_CONVERSATION_ID
rat-things chat --thread release-smoke --attach updated-spec.pdf \
  --reply-to MESSAGE_ID --delivery interrupt \
  "Use this revision for the next analysis"
```

With no options, `npm run rat-things -- "your prompt"` uses the owner's default `main` thread. Use
the same thread name and exact execution policy for continuation. Agents can use the explicit
`chat` command and add `--json` to retain run/session evidence, `--no-wait` for a receipt-only
submission, or an explicit
`--idempotency-key` when a supervising test process needs retry-safe message identity. AWS Codex
authentication remains deployment-controlled (normally short-term Bedrock auth); the CLI never
uploads local ChatGPT credentials. A thread's execution and integration policies are fixed by its
first accepted Run; incompatible later requests fail with `409`.

## Live App Server interaction

The runner uses the bidirectional Codex App Server protocol, not `codex exec`. Every notification is
assigned an in-memory sequence and can be polled while the run is active:

```bash
rat-things watch RUN_ID --follow
rat-things steer RUN_ID "Use the newly uploaded specification"
rat-things respond RUN_ID REQUEST_ID --answer region=us-west-2
rat-things respond RUN_ID REQUEST_ID --answer-stdin api_token
rat-things interrupt RUN_ID
```

`watch` prints human-readable public activity by default. A single `--json` poll returns one complete
snapshot; `--follow --json` emits one compact snapshot per JSONL line; `--raw` emits one public
activity card per JSONL line. Conflicting `--json --raw` input fails before polling. When a pending
request contains structured questions, the readable view prints each question ID and a copyable
`respond --answer` command. Questions marked secret use `--answer-stdin QUESTION` instead: an
interactive terminal reads without echo, while a pipe supplies exactly one line per repeated
option. This keeps secret values out of shell arguments and process listings. `--result JSON`
remains available for other ordinary request shapes.

Human-readable conversation, activity, question, file, and diagnostic views neutralize C0/C1
terminal controls before writing to a terminal. JSON/JSONL modes do not change the data; JSON
escaping keeps the same strings safe for machine parsing.

`GET .../events` returns
`{runId,active,ready,oldestSequence,nextSequence,events,pendingRequests}`. Each public event has a
stable `kind`, `status`, `title`, optional bounded `detail`, sequence, and timestamp. Raw App Server
methods and parameters, commands, results, reasoning, request parameters, and native thread/turn IDs
remain inside the execution boundary and terminal evidence. Pass the last seen `sequence` back as
`after`; results are ordered and bounded to 100. If a client falls behind `oldestSequence`, it
missed entries from the bounded ring and must rely on the terminal JSONL event artifact. The CLI
prints that loss explicitly rather than presenting the retained window as complete.
`pendingRequests` includes only ordinary server requests awaiting JSON data. The response route does
not authorize commands, file changes, browser actions, integrations, or broader account access. Rat
Things has no approval route; its capability envelope is fixed before launch.

### Live browser viewing, takeover, and teaching

For an active browser-enabled Run, `GET /v1/runs/{runId}/computer` returns a bounded JPEG data URL,
page title/URL, control state, and demonstration state. The request is owner-checked and then
proxied with an AWS-issued token to the exact MicroVM lifecycle port; Chromium itself has no public
listener.

`POST .../computer/takeover` with `{"control":"human"}` grants a renewable fifteen-minute exclusive
browser lease. Agent browser calls fail while it is held. `{"control":"agent"}` returns the browser.
The lease changes interaction ownership only—it does not interrupt other reasoning or widen tools,
IAM, networking, integration grants, provider scopes, or resource limits.

`POST .../computer/action` accepts the OpenAPI `HumanBrowserAction` union (`navigate`, `click`,
`type`, `press`, `select`, `scroll`, `wait`, or `back`) only while human control is active. There is
no arbitrary DevTools, JavaScript, shell, VNC, or desktop command surface.

The CLI provides a typed command for every member of that union and retains `computer act --file`
for generated JSON actions:

```bash
rat-things computer takeover RUN_ID
rat-things computer navigate RUN_ID https://example.com
rat-things computer click RUN_ID --ref r3
rat-things computer type RUN_ID --ref r4 --clear --submit "quarterly revenue"
rat-things computer scroll RUN_ID --delta-y 600
rat-things computer release RUN_ID
```

`POST .../computer/teach` starts or stops a bounded action demonstration for up to ten minutes and
100 actions. It deliberately does not retain video. Navigation query strings/fragments and
typed/selected values are excluded from the generated instructions; values become `{{input_N}}`
placeholders. Stopping with
`discard:false` creates a manual, unpublished Thing draft. It never tests, publishes, schedules, or
runs that Thing. `discard:true` deletes the unfinished recording and creates nothing. See
[browser computer use](browser-computer-use.md) for console and CLI use and the remaining security
boundaries.

This is a live control plane, not the durable event archive. The complete JSONL event artifact is
written to encrypted S3 after the turn, while the live in-MicroVM ring is bounded and disappears
when the execution ends. API Gateway authenticates the owner, then trusted control orchestration
mints a short-lived proxy token for the exact MicroVM and port 8080; that endpoint and token never
reach the caller or agent child.

## Routines

A routine stores one validated run request and submits it on an interval. DynamoDB keeps only the
schedule, status, hash, and encrypted S3 reference; prompt and integration selections stay in the
artifact plane.

Routines remain a lower-level interval compatibility primitive. Use manual or EventBridge
rate/cron Things for new reusable work so draft testing, immutable publish, explanation, and trigger
health stay in one lifecycle.

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
records when that manual execution was first accepted. Routine list/get responses expose that
accepted Run as `lastRunId` and `lastRunAt`, including when the Routine is paused; an older retry
cannot replace newer run history.

Routine requests cannot set `source`, `parentRunId`, a `source` delivery destination, or reserved
routine metadata. At execution, trusted orchestration rechecks the owner-scoped S3 key and canonical
request digest, adds system provenance and schedule metadata, and submits through the ordinary run
service. Routines do not bypass account grants or capability profiles. Use the narrowest profile,
IAM, egress, provider scopes, and grants for autonomous side effects.

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

`Idempotency-Key` is required when `thread` is present, otherwise optional, and must contain 1–200
characters from `A-Z a-z 0-9 . _ : -`. Within one owner namespace:

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
| `thread` | No | `{ "key": "...", "delivery"?: "interrupt"|"defer" }`; requires `Idempotency-Key` and still returns this Run immediately |

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
| `capabilities` | Profile plus network, search, browser, skill, app, and MCP selections |
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
There is no owner-facing inventory endpoint for skill, app, or MCP names in v1. An omitted profile
allowlist means that profile does not narrow names; it is not evidence that a name is installed.
Hosts must supply valid names, and runtime resolution fails unavailable selections.

The `small-business` profile allows browser use and up to read-write integrations.
`microvm-full` permits full integrations. Both are autonomous once launched; the difference is the
size of the admitted envelope, not an approval mode.
Because Codex's `danger-full-access` policy has no independent command-network switch, explicitly
setting `networkAccess: false` automatically narrows the effective inner sandbox to
`workspace-write`; the outer MicroVM remains the isolation boundary.
Use broad profiles only when every external side effect is already bounded by connection grants,
provider scopes, IAM, and egress policy. See [the capability envelope](capability-envelope.md).

See [browser computer use](browser-computer-use.md) for the implemented command surface, live-AWS
evidence, safety boundaries, and the capabilities still required before making an unqualified
“full computer use” claim.

### `integrations`

`connectionSet` selects a reusable owner-scoped set. `connections` selects up to 32 aliases or IDs;
each entry can add a `read-only`, `read-write`, `full`, or `custom` per-run ceiling plus operation
allow/deny lists. When both are present their connection selections are merged, and all applicable
provider authorization, persistent grant, profile, and run constraints are intersected. Credentials,
grant IDs, provider scopes, resource constraints, and secret references are not
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
  "status": "queued",
  "createdAt": "2026-08-02T19:12:20.000Z",
  "updatedAt": "2026-08-02T19:12:20.000Z",
  "expiresAt": 1788299540,
  "sourceKind": "api"
}
```

The stored record still contains host-created provenance, the derived owner namespace, immutable
request evidence, conversation bindings, and execution handles. A caller cannot submit those fields
as part of the v1 request, and the public run projection never returns them. They remain available
only to trusted orchestration and owner-checking code.

All normal responses include `Cache-Control: no-store`. Submission also includes
`Location: /v1/runs/{runId}`.

Terminal success adds a sanitized `execution` summary and a `result` containing a 2,000-character
preview, exit code, duration, optional token usage, and user-visible file metadata with checksums.
The full Markdown output, JSONL events, optional workspace patch, and catalog bytes remain behind the
owner-checked artifact routes; the response does not contain their S3 references or the Codex thread
ID.
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

An artifact URL route first verifies run or conversation ownership and verifies that the object
belongs to the runtime bucket. With publication delivery enabled, it creates a bearer grant with a
deployment-configured 60–86,400 second lifetime (86,400 seconds by default). The grant URL is on an
isolated publication subdomain; redemption redirects to a signed browser-ready `index.html` and
installs equivalent CloudFront cookies for its subresources. The signed first page does not depend
on a browser preserving cookies through the redirect. Grant expiry is independent of the control
Lambda's rotating role credentials, and CloudFront reads bytes from private S3 through Origin
Access Control. Without publication delivery, the authenticated route returns a direct one-minute
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
    "message": "prompt cannot be empty",
    "retryable": false,
    "traceId": "API_GATEWAY_REQUEST_ID"
  }
}
```

Expected mappings are `400 invalid_request`, `403 forbidden`, `404 not_found`, and `409 conflict`.
Unexpected errors return `500 internal_error` with a generic client message; bounded details are sent
to CloudWatch Logs. All error envelopes also include `retryable` and a transport `traceId`. A `202`
from a webhook can mean an authenticated but unsupported event was intentionally ignored and need
not contain a run ID; see [channels](channels.md).
