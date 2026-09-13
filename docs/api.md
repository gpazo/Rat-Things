# Control API reference

Use the [Agents API](agents-api.md) for Agent, Session, Turn, Item, environment,
Vault, File, Skill and Artifact operations. The official SDK uses the deployment's
Agents endpoint, including live SSE. The control endpoint below owns IAM-authenticated
integration installation, provider bindings, schedules and Session artifact publications. The public Run and conversation APIs are removed.

The deployment's `/openapi.json` is authoritative for installed routes. Signed
provider ingress resolves the binding creator as Session owner and retains the
provider sender separately. See [provider bindings](schedules.md#provider-bindings).

## Authentication and ownership

Deployment discovery and contract documents (`GET /health`, `GET /.well-known/rat-things`,
`GET /openapi.json`, and `GET /schemas/*.json`) are public and contain no owner data. Publication
share redemption uses its own bearer grant. Every other integration/application control route requires an IAM
principal supplied by API Gateway through its `userArn` or `callerId`.

The handler derives `ownerId` from that value. A caller cannot supply or select its owner. The
`X-Runtime-Owner` escape hatch works only when `ALLOW_OWNER_HEADER=true`; this is for isolated local
testing and must be false in a deployed stack.

The included Terraform module configures `AWS_IAM` on owner-scoped control routes and no
authorization on the discovery/contract routes. The handler contains a JWT `sub` extraction hook
for a separately maintained transport adapter, but v1 discovery/OpenAPI does not advertise bearer
authentication; it is not a supported direct-client surface in the provided stack.

Resources are readable, listable and cancellable only by their derived owner. Provider
Sessions belong to the authenticated creator of the matching source binding.

## Routes

| Method and path | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | None | Liveness response; does not prove worker/model/provider readiness |
| `GET /.well-known/rat-things` | None | Deployment capabilities plus relative OpenAPI and schema links |
| `GET /openapi.json` | None | OpenAPI 3.1 contract for headless consumers |
| `GET /schemas/agents-api.schema.json` | None | Generated upstream resource schemas |
| `POST /v1/sessions/{sessionId}/publications` | Required | Publish selected saved Session artifacts; see [Publications](publications.md#control-api) |
| `GET /v1/schedules` / `POST /v1/schedules` | Required | List or create schedules; see [schedule operations](schedules.md) |
| `GET /v1/capability-profiles` | Required | List installed capability-policy ceilings |
| `GET /v1/integrations/plugins` | Required | List trusted integration manifests and operation schemas |
| `POST /v1/integrations/oauth/authorizations` | Required | Create a ten-minute owner-bound OAuth state and PKCE authorization URL from one configured plugin |
| `GET /v1/integrations/oauth/callback` | None | Provider redirect target; atomically consumes state, exchanges/verifies the code, and stores the credential |
| `GET /v1/integrations/connections` | Required | List the owner's connections, persistent grants, and bounded health; never returns credentials |
| `POST /v1/integrations/connections` | Required | Verify one provider credential, derive account metadata, then create its secret and initial grant |
| `GET /v1/integrations/connections/{connectionId}` | Required | Get one connection, grant, and bounded health by ID or stable alias |
| `PATCH /v1/integrations/connections/{connectionId}` | Required | Change the display name without changing the stable alias or provider identity |
| `POST /v1/integrations/connections/{connectionId}/test` | Required | Host-side credential verification that returns bounded health and never exposes the credential |
| `GET /v1/integrations/connections/{connectionId}/consumers` | Required | Derive owner-scoped Sessions, schedules, sets, and source bindings that select this account |
| `POST /v1/integrations/connections/{connectionId}/grant` | Required | Replace the account's persistent Rat-side grant |
| `POST /v1/integrations/connections/{connectionId}/credential` | Required | Verify and rotate a credential without changing provider account identity |
| `POST /v1/integrations/connections/{connectionId}/oauth/reconnect` | Required | Start a short-lived OAuth reconnect bound to the existing connection, grant, and verified provider identity |
| `POST /v1/integrations/connections/{connectionId}/revoke` | Required | Revoke the connection and its credential |
| `GET /v1/integrations/connection-sets` | Required | List reusable multi-account connection sets |
| `POST /v1/integrations/connection-sets` | Required | Create a reusable multi-account connection set |
| `GET /v1/integrations/source-bindings` | Required | List verified-source capability bindings |
| `POST /v1/integrations/source-bindings` | Required | Bind a verified source selector to an owned Agent and environment |
| `GET /__share/{token}` | Bearer token | Redeem a publication grant for host-only CloudFront signed cookies |
| `POST /webhooks/github` | Provider signature | Optional GitHub event ingress; verifies the raw body before normalization |
| `POST /webhooks/gitlab` | Provider signature | Optional GitLab event ingress with signed-standard and legacy verification |
| `POST /webhooks/teams` | Provider signature | Optional Teams activity ingress with immediate acknowledgement |
| `POST /webhooks/slack` | Provider signature | Optional Slack event ingress with timestamp/replay checks |

The standard Agents transport supports live SSE and saved Items. Callers do not
select private MicroVM execution IDs or receive AWS-issued proxy tokens. Trusted Session orchestration owns
continuation and cancellation. Provider receipts identify the accepted integration
input; they do not expose private execution records.

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

Connection creation does not accept an idempotency key. If its response is lost,
reconcile provider-derived identity from the owner list before retrying.

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
`rat-things slack-events ACCOUNT --agent-id AGENT_ID [--environment-template TEMPLATE_ID] [--json]` derives the team selector from the
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
contracts; they should not load that broad corpus or guess every operation for a simple Session. See
[Connect an agent to Rat Things](agents.md).

Installed JSON Schemas use relative `$id` values, so relative references resolve against the exact
deployment that served them rather than silently switching to the central documentation copy.
Schema `maxLength` is character-based preflight; runtime UTF-8 byte limits remain authoritative.

Errors use a stable envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Invalid schedule expression",
    "retryable": false,
    "traceId": "API_GATEWAY_REQUEST_ID"
  }
}
```

Preserve `traceId` when reporting an issue. `invalid_request`, `forbidden`, `not_found`, and
`conflict` are not retryable without changing state or input. Unexpected internal failures hide
their details from the caller and set `retryable: true`; use bounded structured logs for diagnosis.

## Durable files

Use the standard Files API for uploads and Session Artifacts for retained output.
Artifact downloads require the owning principal. Creating a publication is an
explicit application operation that mints an expiring bearer grant; it does not
change the Session resource. See [durable files](durable-files.md) and
[sharing work](sharing-work.md).

## Schedules

Schedules target an Agent and environment using the separate
[schedule contract](schedules.md). Execution, provider ingress, and result
notification remain separate stages.
