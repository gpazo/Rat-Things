# Things: reusable agent automations

A **Thing** is Rat Things' product-facing automation contract. It says what an agent should achieve,
when it may run, which connected accounts it may use, the capability profile that limits it, and
where its result should go. A Thing contains no credential value and no user, organization, or
OAuth-client implementation.

Use Things when building an operator workflow or embedding Rat Things in another product. The older
routine and raw-run APIs remain lower-level primitives; new consumers should start with Things.

## The shortest working flow

Create a draft from the repository example, inspect its deployment-specific resolution, test it,
then enable it:

```bash
rat-things thing-create --file examples/thing-create.json
rat-things thing-explain THING_ID
rat-things thing-run THING_ID --idempotency-key first-safe-test
rat-things get RUN_ID
rat-things thing-enable THING_ID
```

Remote CLI commands use `RAT_THINGS_API_URL`, infer an AWS Region from an API Gateway URL when
possible, and SigV4-sign control requests. `thing-run` accepts an optional idempotency key; repeat
the same key to retry the same semantic run safely.

The equivalent create request is:

```http
POST /v1/things HTTP/1.1
Content-Type: application/json

{
  "version": "1",
  "status": "draft",
  "spec": {
    "version": "1",
    "name": "Customer operations review",
    "goal": "Review support messages and payment exceptions. Do not issue refunds without approval.",
    "trigger": { "kind": "interval", "everyMinutes": 60 },
    "agent": {
      "capabilities": {
        "profile": "small-business",
        "computerUse": "browser"
      }
    },
    "connections": {
      "accounts": [
        { "account": "slack-support", "access": "read-only" },
        {
          "account": "stripe-business",
          "access": "read-write",
          "denyOperations": ["stripe.refunds.create"]
        }
      ]
    },
    "deliver": [{ "kind": "slack", "route": "C01234567" }]
  }
}
```

The response is metadata, not the complete goal:

```json
{
  "version": "1",
  "thingId": "...",
  "revision": 1,
  "name": "Customer operations review",
  "status": "draft",
  "trigger": { "kind": "interval", "everyMinutes": 60 },
  "specHash": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

`GET /v1/things/{thingId}` returns the authenticated owner's complete current spec. List responses
omit it so a routine inventory does not unnecessarily copy goals into logs or UI tables.

## ThingSpec v1

The machine contract is published as
[ThingSpec v1 JSON Schema](../spec/schemas/thing-v1.json). Create and version envelopes have their
own [create schema](../spec/schemas/thing-create-v1.json) and
[version schema](../spec/schemas/thing-version-v1.json). A deployment serves the same files from
`/schemas/...`; the centrally hosted documentation serves them from `/schemas/...` as well.

| Field | Meaning |
| --- | --- |
| `version` | Contract version; currently exactly `"1"` |
| `name` | Human-facing label, at most 128 UTF-8 bytes |
| `goal` | Agent instruction, at most 100,000 UTF-8 bytes |
| `trigger` | `manual` or an `interval` from 1 to 525,600 minutes |
| `repository` | Optional credential-free HTTPS repository selection |
| `agent` | Model, reasoning, sandbox, profile, browser, search, skills, apps, and MCP selection |
| `connections` | Optional connection set and/or multiple explicit account selections |
| `execution` | Optional MicroVM backend and timeout selection |
| `deliver` | Up to eight explicit `teams`, `slack`, or `none` destinations |
| `metadata` | Bounded application JSON; trusted Thing occurrence keys are reserved |

Thing specs cannot contain `repository.credentialSecretArn`. Bind private source-control access as
a deployment-owned connection; until that adapter is installed, use the lower-level run API for an
explicit host-controlled repository secret reference.

Things deliberately cannot set a provider `source`, a parent run, or the `source` delivery
destination. A manual Thing has an authenticated API source, not a forged Slack, Teams, GitHub, or
GitLab source. Provider webhooks continue through their signature-verified ingress adapters.

### Triggers

`manual` means an authenticated API or CLI consumer decides when to run:

```json
{ "kind": "manual" }
```

`interval` runs through the deployment reconciler:

```json
{
  "kind": "interval",
  "everyMinutes": 15,
  "startAt": "2026-08-24T09:00:00-07:00"
}
```

`startAt` is optional and requires an ISO date-time with an offset. Without it, the first
occurrence is one interval after the Thing becomes enabled. The scheduler skips accumulated
backlog rather than launching a storm. A scheduled occurrence is idempotent on Thing ID, revision,
and scheduled time; its schedule advances only after durable run submission succeeds.

The live AWS suite enables a one-minute interval Thing, makes no explicit run request, waits for the
EventBridge reconciler, and asserts that exactly one durable occurrence retains the expected Thing,
revision, scheduled-time, and source provenance before pausing it. Scheduled routine occurrence
validation remains separate.

Generic signed-Thing webhooks and provider-event Thing triggers are not part of ThingSpec v1 yet.
Do not simulate them with an unauthenticated manual route. Use the existing signature-verified
provider webhooks until a per-Thing secret lifecycle and replay contract are added.

### Multiple accounts and permissions

`connections.set` selects a reusable owner-scoped connection set by name or ID. `accounts` adds or
narrows exact connection aliases or IDs. More than one account may use the same plugin:

```json
{
  "connections": {
    "set": "agency-defaults",
    "accounts": [
      { "account": "slack-agency", "access": "read-write" },
      { "account": "slack-client-a", "access": "read-only" },
      { "account": "slack-client-b", "access": "custom", "allowOperations": ["slack.messages.search"] }
    ]
  }
}
```

`access` is a per-Thing ceiling. It cannot widen the provider token, persistent Rat grant, or
capability profile. Effective authority is their intersection. `denyOperations` wins over an
allowlist; `custom` requires explicit allowed operations. Credential values stay in the host's
Secrets Manager and are read only immediately before an authorized tool call. See
[integrations, accounts, and permissions](plugins.md) for provider scope, resource constraint, and
approval behavior.

## Lifecycle and immutable revisions

Thing lifecycle is separate from its immutable definition:

| Status | Scheduled trigger | Explicit test run | Can add a revision? |
| --- | --- | --- | --- |
| `draft` | No | Yes | Yes |
| `enabled` | Yes, for intervals | Yes | Yes |
| `paused` | No | Yes | Yes |
| `archived` | No | No | No |

Create in `draft` unless the exact spec and its external side effects have already been reviewed.
`POST .../enable`, `POST .../pause`, and `POST .../archive` accept `{}`. Archive is terminal so an
old automation cannot be accidentally reactivated. Archived Things are omitted from list results
unless `includeArchived=true` or CLI `things --all` is used.

Editing creates another immutable revision with compare-and-swap protection:

```http
POST /v1/things/THING_ID/versions HTTP/1.1
Content-Type: application/json

{
  "version": "1",
  "expectedRevision": 1,
  "spec": {
    "version": "1",
    "name": "Customer operations review",
    "goal": "Review only; make no external changes.",
    "trigger": { "kind": "interval", "everyMinutes": 30 }
  }
}
```

If another writer selected revision 2 first, the stale request returns `409 conflict`. Historical
definitions remain retrievable at `GET .../versions/{revision}` and are content-digested. The
definition bucket is encrypted, versioned, private, and has no automatic run-artifact expiry;
DynamoDB contains only lifecycle metadata and S3 references.

## Explain before running

`GET /v1/things/{thingId}/explain` and `rat-things thing-explain` are the primary debugging surface.
They do not read or return credential values. The response includes:

- the stored spec after digest validation;
- its direct compiled run request;
- the effective run request after capability-profile resolution;
- every resolved account and how it was selected;
- provider authorization metadata and the persistent Rat grant;
- each installed operation's final allowed/denied, approval, and enforcement decision; and
- actionable lifecycle, missing-profile, missing-set, missing-account, revoked-account, and
  unknown-operation diagnostics.

`runnable` is false when the Thing is archived or an environment dependency cannot resolve. A
warning means an explicit draft/paused test is still possible; an error predicts that execution
would fail and should be repaired first.

## API and CLI reference

| API | CLI | Purpose |
| --- | --- | --- |
| `GET /v1/things` | `things [--all]` | List owner-scoped summaries |
| `POST /v1/things` | `thing-create --file ...` | Create revision 1 |
| `GET /v1/things/{id}` | `thing ID` | Get current definition |
| `GET .../{id}/versions` | `thing-versions ID` | List immutable version metadata |
| `GET .../{id}/versions/{revision}` | `thing-version ID REVISION` | Get one historical definition |
| `POST .../{id}/versions` | `thing-version ID --file ...` | Select a new immutable revision |
| `GET .../{id}/explain` | `thing-explain ID` | Resolve effective environment and permissions |
| `POST .../{id}/run` | `thing-run ID` | Submit an explicit/test run |
| `POST .../{id}/enable` | `thing-enable ID` | Activate a trigger |
| `POST .../{id}/pause` | `thing-pause ID` | Stop scheduled triggering |
| `POST .../{id}/archive` | `thing-archive ID` | Make the Thing terminal |

Use `GET /.well-known/rat-things` to discover these contracts from a deployment rather than
hard-coding the centrally hosted URL. See [embedding and self-hosting](embedding.md) for identity,
deployment, and frontend boundaries, and [diagnostics](diagnostics.md) when a flow does not behave
as expected.
