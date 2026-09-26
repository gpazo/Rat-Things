# Agents API in your AWS account

Rat Things implements the OpenAI Agents API resource model using the official
OpenAI SDK. Your AWS account owns the API service, agent harness, session state,
execution environments, credentials, encrypted files and executor relay. Model
requests use the model provider configured by the deployment operator.

The upstream reference is the [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview).
The deployment's `/openapi.json` and `/schemas/agents-api.schema.json` describe its
installed routes and pinned SDK types. This implementation is an engineering
preview; matching resource types does not establish complete behavioral parity
with OpenAI's hosted service.

## Export traces to your own tools

Rat Things captures structural trace information in its encrypted AWS storage.
No collector is required. Read a page with
`GET /v1/agents/sessions/{session_id}/traces?limit=20&order=asc`; when `has_more`
is true, pass `last_id` as `after` for the next page. The response contains
`data[].otlp.resourceSpans`. Access follows the Session's owner, and deleting
the Session makes its traces inaccessible through the API.

The CLI can combine all available pages into an OTLP JSON payload:

```bash
rat-things sessions traces sess_123 --output traces.otlp.json
```

To capture a run entirely on your computer, without AWS or a collector:

```bash
rat-things local --trace-output traces.otlp.json "Explain this repository"
```

Send the resulting file to your own collector's OTLP/HTTP receiver, for example
one listening locally:

```bash
curl --fail-with-body http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' --data-binary @traces.otlp.json
```

Configure authentication yourself when sending to a remote collector. Rat Things
does not store collector credentials or automatically forward telemetry.

Traces become available after a root Turn ends; later child completion or usage
can add information. Export again after the Session finishes to obtain that
information. Repeated exports preserve trace and span IDs. Captured timing,
outcomes, hierarchy and available token counts are included; prompts, tool
arguments/results, credentials and reasoning content are excluded. Where the
harness reports only a completion, the span has zero duration and a
`rat_things.timing=completion_only` attribute. Older runs have no retrospectively
captured tool or generation spans. Local mock runs have an agent span only.

## Scoped API keys

AWS IAM authenticates token issuance; Rat Things keeps its own owner identity.
OpenAI organization/project key administration is outside this contract.
Pass `scopes` to `createAgentsClient` to request a narrowed bearer grant:

```ts
const client = createAgentsClient({
  baseURL: process.env.RAT_THINGS_AGENTS_API_URL!,
  region: process.env.AWS_REGION!,
  scopes: ['api.agents.read', 'api.traces.read'],
});
```

Omitting `scopes` grants all supported operations; `[]` grants none. The IAM-only
`POST /v1/auth/tokens` endpoint accepts the same optional `scopes` array, returns
the granted scopes, and stores them with the token digest, owner, audience and
15-minute expiry. An existing bearer token cannot issue or widen a grant.
Explicitly scoped clients reject an issuer that omits scopes or returns broader
authority. Direct IAM API calls retain their IAM-authenticated owner's full API
authority; narrowed clients must use the bearer endpoint.

| Scope | Authority |
| --- | --- |
| `api.agents.read` | Read Agents, Sessions, history, environments and traces |
| `api.agents.write` | Create, update and delete those resources; cancel Turns |
| `api.responses.write` | Additionally required for initial input, messages and function results that can trigger inference |
| `api.vaults.read` | Read Vaults and credential metadata |
| `api.vaults.write` | Create, rotate and delete Vault credentials |
| `api.traces.read` | Read Session traces without general Agents read access |

Write authority does not imply read authority. Owner isolation applies to every
grant. Session creation without input needs only Agents write authority; any
batch containing a message or function result also requires inference authority
before any event is applied. As a Rat Things extension, Files, Skills and webhook
administration use the corresponding Agents read/write scope. These mappings do
not reproduce OpenAI account administration.

## Connect

Use the Terraform `agents_api_base_url` output as the SDK base URL. Configure the
AWS region and a principal authorized to invoke the deployment's token issuer.
The supplied client obtains a short-lived API key through AWS IAM and refreshes
it without changing SDK request or response types:

```ts
import { createAgentsClient } from './dist/agents-client.mjs';

const client = createAgentsClient({
  baseURL: process.env.RAT_THINGS_AGENTS_API_URL!,
  region: process.env.AWS_REGION!,
});

const agent = await client.beta.agents.create({
  name: 'Research assistant',
  model: process.env.RAT_THINGS_MODEL!,
  instructions: 'Explain your conclusions and identify missing evidence.',
});

const session = await client.beta.agents.sessions.create({
  agent_id: agent.id,
  environment: { type: 'none' },
  input: 'Explain the difference between an Agent, a Session and a Turn.',
});
console.log(session.id);
```

An application that already holds a key can use `new OpenAI({ baseURL, apiKey })`
directly. `POST` the IAM-signed `agents_token_issuer_url` to obtain a key. Keys
expire after 15 minutes, are scoped to the issuing principal and deployment, and
are not stored in plaintext. Keep AWS credentials and key issuance in a trusted
backend; the local console does this in its Node process.

The HTTP service exposes `/.well-known/agents-api` for issuer discovery. The
client only signs issuance requests to a Lambda URL in its configured AWS region.
The Lambda fallback accepts IAM-signed SDK requests directly, but retains AWS's
request-size and invocation-duration limits. Use the HTTP service for full-size
uploads and long-lived event streams.

## Resource model

| Resource | Responsibility |
| --- | --- |
| Agent | Reusable model, instructions, tools, reasoning, text and delegation settings |
| Session | Resolved configuration and ongoing work across turns |
| Turn | One period of agent work, with independent completion, failure or cancellation |
| Item | Saved messages, public reasoning summaries, tool calls and results |
| Environment template | Reusable packages, input files, skills, plugins and setup |
| Environment | The session's connected command and filesystem context |
| Vault | Owned, write-only credentials for MCP or sandbox HTTPS destinations |
| File / Skill | Uploaded content and versioned capabilities for environment setup |
| Artifact | An immutable copy of a managed environment output |

Session creation snapshots the Agent and resolves its environment template.
Later Agent edits do not change an existing Session. Supplied objects and arrays
replace the corresponding saved fields. The requested model identifier is passed
to the configured provider without silently choosing another model.

Session model updates validate the resolved reasoning effort against the
installed API capability catalogue before saving. Service tiers use the API
enum and are passed through to the provider; interactive Codex menu entries
do not determine API tier availability. The provider enforces tier entitlement
and capacity. Reset incompatible
settings in the same request when changing models. `openai.` provider aliases
use the corresponding model's capabilities without rewriting the requested
identifier. Uncatalogued models cannot be selected through a Session update;
operators must review the catalogue when adding model support. This check does
not grant provider access or guarantee available capacity.

The installed reasoning matrix is:

| Model | Accepted explicit reasoning efforts |
| --- | --- |
| `gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-daybreak-blue-latest` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-daybreak-red-latest` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.5` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-mini` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.2` | `none`, `low`, `medium`, `high`, `xhigh` |
| `codex-auto-review` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.4-mini-2026-03-17` | `none`, `low`, `medium`, `high`, `xhigh` |

The registry is maintained in `runtime/codex/model-capabilities.json`. The
GPT-5.4 Mini API supports `none` and its dated snapshot, as documented in the
[model reference](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
This is the Session-update support set. Initial Agent definitions may name a
provider-specific model; that does not promise later model-setting updates or
provider access. Adding a model requires explicit capability review.

Input sent to an idle Session starts a Turn. Input sent while the coordinator is
working steers that Turn. Canceling a Turn preserves the Session. A failed or
expired environment is terminal for that environment; create another Session.
Workers send durable keep-alives while the Session harness is connected, including
between Turns. Closing a stream or completing a Turn does not start an expiry
timer. After one hour without a durable worker keep-alive, reconciliation fails
the exact stale execution and stops its verified worker. A concurrent keep-alive
or replacement prevents that stop; uncertain worker identity remains quarantined
until it can be verified. Earlier verified worker loss may be retired sooner.
Unexpected worker loss can replace a hosted sandbox on the next Turn. The
environment ID and conversation remain stable, declared inputs are prepared
again, and previous sandbox files and processes are lost. The
`agent.session.environment.reset` event carries a monotonically increasing
`reset_count`; duplicate notifications for one replacement share that count.
Cancellation does not replace a Turn's completed or failed outcome. For work
already admitted to the harness, inspect the Turn until its outcome is terminal.
Deleting a Session closes its execution authority even if its first harness has
not started, so delayed dispatch cannot claim a new harness for that Session.

```ts
await client.beta.agents.sessions.events.create(session.id, {
  events: [{
    type: 'agent.session.input.message',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Add an example.' }] }],
  }],
  'Idempotency-Key': 'example-request-1',
});

for await (const event of await client.beta.agents.sessions.events.stream(session.id)) {
  console.log(event.type);
}
```

SSE is a live stream. Recover missed work from saved Items and Turns; reconnecting
does not replay an event log. Disconnecting a stream does not cancel execution.
Function tool results must identify the pending call and Turn. Successful results
provide `output`; failed results provide `error`. Human approval requests are not
part of the runtime: the deployment admits a fixed capability envelope before
execution, and enforcing layers deny operations outside it.

## Session webhooks

Configure an owned endpoint with `POST /v1/webhooks` on the API service. Supply a
public HTTPS `url` and the Session event types to receive:

```json
{
  "name": "Session lifecycle",
  "url": "https://app.example.com/webhooks/agents",
  "events": ["agent.session.action_required", "agent.session.idle", "agent.session.failed"]
}
```

The response includes a `signing_secret` once. Store it in your receiving
application and verify the raw request body with
`client.webhooks.unwrap(body, headers, signingSecret)` from the OpenAI SDK.
Endpoint reads never return that secret. Use `POST /v1/webhooks/{id}/rotate-secret`
to replace it, `POST /v1/webhooks/{id}` with `{"enabled": false}` to pause delivery,
or `DELETE /v1/webhooks/{id}` to remove the subscription.

Supported events are `agent.session.created`, `agent.session.action_required`,
`agent.session.in_progress`, `agent.session.idle` and `agent.session.failed`.
The webhook uses `action_required`; the stream uses `requires_action`. Retrieve
the Session for current required-action details. A connection-required webhook
is committed before the service waits for a self-hosted executor. The creation
webhook includes its environment ID and relay URL.

Return a `2xx` response promptly after accepting the event. Delivery retries with
exponential backoff for up to 72 hours; redirects are treated as failures. The
`webhook-id` stays the same across retries, so receivers can deduplicate an event
whose acknowledgement was lost. Webhook retries have independent queues from
Session execution. Events and delivery state remain in your encrypted AWS storage.
Session deletion has no deletion webhook. An idle Session can have a failed or
cancelled last Turn; inspect the Turn to determine its outcome.

## Environments and ownership

- `none` provides model and declared service/function tools without a command
  environment. Initial input is required.
- `openai_hosted` is the upstream wire discriminator for a managed environment.
  **In this deployment, Rat Things provisions it in your AWS account.** The
  workspace is `/workspace`. Packages and input capabilities are prepared before
  ordered setup commands; a failed setup prevents agent execution.
- `self_hosted` connects compute that you prepare to your deployment's encrypted
  relay. The harness and Session storage still run in your AWS account. Supply
  the workspace and capability directories, then connect the executor using its
  environment-specific credential.

```bash
npm run rat-things -- environments connect ENVIRONMENT_ID
```

The connection command uses the pinned stock Codex executor. Its local registration
shim targets this deployment's relay; the encrypted execution channel terminates
in infrastructure you operate. Executor and harness credentials have different
roles and are revoked when the environment is retired.

Retrieve `GET /v1/agents/environments/{environment_id}` to check readiness.
The environment `status` is `pending` while setup or the initial executor
connection is unfinished, and `connected` when ready. Wait for `connected`
before using live file operations. The other response statuses are
`disconnected`, `expired` and `failed`; a disconnected self-hosted executor
can reconnect, while an expired or failed environment is unavailable.
These values follow the [Environment API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/environments/methods/retrieve).
The hosted guide calls the setup phase `provisioning`, but that is not a
response status; clients should handle `pending`. The corresponding stream
event is `agent.session.environment.pending`.

Managed network settings support enabled, disabled and restricted access.
Restricted lists contain exact hostnames. Session overrides can narrow a
template's network policy. Commands, setup and managed environment MCP processes
run under that policy. Service-origin MCP connects from the trusted harness to
its configured destination; environment-origin MCP connects from the environment.

The MicroVM service imposes a maximum execution lifetime. Environments and
harnesses can become unavailable independently of saved Session history. Treat
environment status and Turn errors as authoritative; retain durable output as
Artifacts rather than relying on a live workspace indefinitely.

## Files, skills and artifacts

Upload binary content with `client.files.create({ file, purpose: 'user_data' })`.
Environment setup and live file writes accept inline base64 or an owned File ID.
Inline files allow 5 MiB each and 10 MiB together at creation; File ID inputs allow
50 MiB each. Large live writes use internal chunks and publish the destination
only after validating the complete file checksum.

Skills use `client.skills` and immutable versions. Managed setup pins selected
File content and Skill versions so later edits or deletion of the original
resources do not change that environment's prepared inputs.

Files in `/workspace/outputs` in managed environments become immutable Artifacts
when a Turn finishes. The API supports up to 200 MiB per artifact and 500 MiB per
output snapshot. These saved copies survive environment expiry. Self-hosted
environments do not implicitly publish their live files as Artifacts.

Capability archives are validated for safe paths, metadata and file counts. ZIP
uploads allow 50 MiB, with at most 500 files of up to 25 MiB each. Setup expands
entries individually so compressed capabilities need not fit entirely in memory.

## Deploy the public transport

Build Lambda bundles and the ARM64 image from the same checkout:

```bash
npm ci
npm run package
docker build --platform linux/arm64 -f relay/Dockerfile -t rat-agents-api .
```

Publish the image to the deployment's `environment_relay_repository_url`, then set
`environment_relay_image` to its immutable digest. Configure
`environment_relay_origin_hostname` and its matching regional ACM certificate
using `environment_relay_origin_certificate_arn`. Point the origin hostname to
`environment_relay_origin_dns_name`.

Terraform defines separate ARM64 Fargate services for the public API and executor
relay. The API's HTTPS hostname points directly to the load balancer, whose idle
timeout accommodates the five-minute executor connection wait. CloudFront carries
the encrypted executor relay. The API handles large uploads and SSE. MicroVM
workers have no public API ingress. Resource indexes live in DynamoDB; complete
definitions and content live in encrypted S3; confidential credential values live
in Secrets Manager.

Inline MCP credentials have durable cleanup work recorded before creation. If
preparation stops or secret storage returns an uncertain result, the outbox
retries cleanup while protecting credentials adopted by a Session. Deleting a
Session also records its credential cleanup before removing the bindings.
Unresolved cleanup follows the outbox's retry and failure-queue handling.

New Session preparations have a one-day completion window. If creation remains
unfinished, the outbox fences further commits and retires adopted inline MCP
credentials. A retry after that window returns `session_preparation_expired`.
Completed Sessions retain their credentials until deletion. Older preparations
without a recorded deadline require explicit inventory and disposition.

Use the advertised `agents_api_base_url` for SDK requests. CloudFront's default
origin response timeout is shorter than the input connection wait; increasing
its normal quota is unnecessary with the direct HTTPS API endpoint. Both services
authenticate requests, and only the load balancer can reach their container ports.

The issuer authenticates AWS identity before deriving an owner. Public resource
requests cannot choose an owner ID. Running the console uses the same transport:

```bash
RAT_THINGS_AGENTS_API_URL=DEPLOYMENT_BASE_URL AWS_REGION=DEPLOYMENT_REGION \
  npm run console:serve
```

## Application integrations

Signed provider events and schedules now submit canonical Session input. Provider
authentication, delivery, connection installation and scheduling remain separate
integration responsibilities. See [schedules and provider bindings](schedules.md).
The Thing and Routine definitions and public routes are removed.

Integration retries retain the saved Agent settings selected when Session
preparation began, including inherited MCP transport headers. Editing or deleting
that Agent does not change the pending Session's snapshot. A changed request
cannot resume the same pending preparation. Vault grants are still checked when
the Session launches work.

An interrupted Session from an older deployment may lack its original MCP
transport snapshot. Such a preparation returns `session_preparation_incomplete`;
start a new Session instead of reconstructing its settings from a changed Agent.

Publications select immutable Session artifact IDs through the separate
`POST /v1/sessions/{sessionId}/publications` application route. See
[sharing work](sharing-work.md). The public Run/conversation and browser takeover
routes are removed. Session execution calls the private execution service directly.
