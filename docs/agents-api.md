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

## Choose a Session runtime

Rat Things integrates Codex and Pi Durable behind this API. Codex is the default.
Read the [runtime comparison](agent-runtimes.md) for their shared behavior and
limits. Select Pi Durable with the existing SDK metadata field:

```ts
const session = await client.beta.agents.sessions.create({
  metadata: { rat_things_runtime: 'pi' },
  agent: { model: 'amazon.nova-micro-v1:0' },
  environment: { type: 'none' },
  input: 'Explain how this Session works.',
});
```

The selector accepts `codex` or `pi`. An explicit Session selector takes priority
over the saved Agent's selector. Otherwise the Session uses Codex. The server
pins the runtime before preparing an environment. Metadata replacement or clearing
does not change that pin. A conflicting update fails. Forks inherit the source
runtime. Agent metadata changes apply to future Sessions.

Read the pin with `GET /v1/agents/sessions/{session_id}/runtime`. The result
contains `runtime` and the current `model`. Pi also returns `version` and
`catalog_digest`. Runtime is separate from editable metadata and execution
placement. Create a new Session to change runtime.

`GET /v1/models` keeps the Codex model catalog. Add `?runtime=pi` to discover
Pi models and supported environments, tools, and settings. Pi uses only Amazon
Bedrock Converse models admitted by the deployment. A Session pins its approved
catalog. Model updates must stay within that catalog and remain permitted by the
current deployment. Each accepted Turn captures its selected model. The server
never substitutes a different model.

Pi supports no environment or a managed environment, text and model-supported
base64 image data URLs, explicit function tools, MCP, and subagents. Managed Pi
environments require S3 Files and Session checkpoints. Hosted skills, plugins,
and capability directories are unsupported. Function names must be unique
Bedrock identifiers of 1–64 letters, digits, underscores, or hyphens; names used
by the runtime are reserved. Self-hosted environments,
web search, enabled programmatic tool calling, deferred function loading, tool
search, and JSON-schema output are rejected. Pi accepts medium verbosity, the
auto service tier, no reasoning summary, and each model's advertised reasoning
efforts. Omitted or null reasoning effort uses the provider default. An empty
`reasoning` list means that a model supports only that default; it does not
advertise an off setting. Explicit efforts that the adapter would ignore or
clamp are rejected before execution.

The CLI uses the same metadata selector and preserves other JSON fields when
applying flags:

```bash
rat-things agents models --runtime pi
rat-things sessions create --runtime pi --model amazon.nova-micro-v1:0 --input "Explain this Session"
rat-things sessions runtime sess_123
```

`--runtime` and `--model` also apply to Agent creation and updates. Pi requires
a durable Session; standalone `local --driver pi` is rejected. The desktop
console places Runtime before Model and shows the pinned runtime for existing
Sessions. A saved Agent supplies its runtime when starting a Session.

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
backend. The native Rust console delegates authentication to a private Node helper.
Every launch has its own loopback listener and access token. The helper serves only
API requests and closes with the desktop app.

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
Later Agent edits do not change an existing Session. Supported Session settings
can be changed through the Session update endpoint. Supplied objects and arrays
replace the corresponding saved fields. The requested model identifier is passed
to the configured provider without silently choosing another model.

Codex Session model updates validate the resolved reasoning effort against the
installed API capability catalogue before saving. Service tiers use the API
enum and are passed through to the provider; interactive Codex menu entries
do not determine API tier availability. The provider enforces tier entitlement
and capacity. Reset incompatible
settings in the same request when changing models. `openai.` provider aliases
use the corresponding model's capabilities without rewriting the requested
identifier. Uncatalogued models cannot be selected through a Session update;
operators must review the catalogue when adding model support. This check does
not grant provider access or guarantee available capacity.

The installed Codex reasoning matrix is:

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
working steers that Turn. Canceling a Turn preserves the Session. For Codex, a failed or
expired environment is terminal for that environment; create another Session.
Workers send durable keep-alives while the Session harness is connected, including
between Turns. Closing a stream or completing a Turn does not start an expiry
timer. After one hour without a durable worker keep-alive, reconciliation fails
the exact stale execution and stops its verified worker. A concurrent keep-alive
or replacement prevents that stop; uncertain worker identity remains quarantined
until it can be verified. Native MicroVM suspension pauses this expiry rule:
reconciliation observes the suspended worker without waking or quarantining it.
On resume, the trusted lifecycle timestamp starts a fresh keep-alive grace period.
The environment may report `disconnected` while frozen because its connection
lease expires; the next control request can still resume the same worker.
Earlier verified worker loss may be retired sooner.
For Codex, unexpected worker loss can replace a hosted sandbox on the next Turn. The
environment ID and conversation remain stable, declared inputs are prepared
again, and previous sandbox files and processes are lost. The
`agent.session.environment.reset` event carries a monotonically increasing
`reset_count`; duplicate notifications for one replacement share that count.
Pi instead reopens its committed task graph after the previous worker is confirmed
terminated. Pending function results and background children keep their identities.
Its managed workspace retains flushed files and setup identity in S3 Files; setup
commands are not replayed after successful setup. A completed tool result is
committed only after the workspace flush succeeds. Effects interrupted before
acknowledgement can have happened; unsafe effects are not automatically repeated.
Missing termination evidence keeps recovery pending, and repeated confirmed
worker failures exhaust the bounded replacement budget.

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

New Sessions use MicroVM by default. Deployment operators can declare exact owner and
saved Agent pairs for EC2 when a workload requires uninterrupted execution beyond eight
hours. Create the Session with that saved `agent_id`; inline Agents and unlisted workloads
remain on MicroVM. Placement is fixed during creation and is not changed by Session age,
metadata edits, or later deployment policy changes. See [Session execution configuration](../infra/README.md#choose-session-execution).

The MicroVM service imposes a maximum execution lifetime. Environments and
harnesses can become unavailable independently of saved Session history. Treat
environment status and Turn errors as authoritative; retain durable output as
Artifacts rather than relying on a live workspace indefinitely.

Deployments that enable private Session checkpoints can release an idle managed worker and
resume it on new compute while retaining workspace files and conversation history. A successful
checkpoint does not rerun setup commands or increment the environment reset count. System
packages are installed again because the operating system is new. Codex replacement without
a valid handoff resets the workspace and reapplies its declared inputs. Pi managed recovery
retains flushed workspace files and setup identity after confirmed termination of the prior
worker. Neither runtime restores running processes. Checkpointing is host-controlled; there
is no public checkpoint endpoint or automatic idle timer.

## Fork a Session

Set `session_checkpoints_enabled = true` with S3 Files configured to enable forks;
the deployment setting defaults to `false`. Enabled deployments support `POST /v1/agents/sessions/{session_id}/fork`,
a Rat Things extension returning `201` with the new standard Session object:

```typescript
const branch = await client.post('/agents/sessions/sess_source/fork', {
  body: { metadata: { attempt: 'b' }, input: 'Try a different approach.' },
});
```

The source must be idle and have a terminal root Turn. Forks use that latest Turn
and its workspace, including installed workspace packages and setup output. Setup
commands are not rerun. Only managed environments with persistent S3 Files storage
support forks. Empty Sessions, older Turn selection, and self-hosted environments
are not supported.

Forking checkpoints a live source and stops its processes. Its next input resumes
the same files and conversation on a replacement worker. An already checkpointed
source stays stopped. While the snapshot is being copied, source mutations return
`409`; retry after the child environment becomes ready. Child preparation is
asynchronous, like ordinary managed Session preparation, and can fail if storage
copying exceeds its limits.

The child receives independent files, a new sandbox and native conversation identity,
and the source's snapshotted Agent settings. Optional `vault_ids` must be a subset
of the source's vaults; optional `environment.network` may only narrow network access.
Credentials are prepared again for the child. Browser profiles, authentication files,
caches, transient artifacts, and subagent threads are excluded. Each copy is bounded
to 256 MiB, 50,000 traversal/copy steps, and 90 seconds. Absolute or escaping symbolic
links, hard-linked files, and special files are rejected. Temporary immutable snapshots expire after
seven days; the child's files and recovery history are independent of them.

User metadata defaults to an empty object. Public Items and Turns begin empty, while
the native conversation retains context. Private recovery history survives deletion
of the source. Read provenance with `GET /v1/agents/sessions/{session_id}/lineage`;
the result is `{ forked_from: { session_id, turn_id, created_at } }`, or
`{ forked_from: null }` for an ordinary Session.

Forking requires both `api.agents.read` and `api.agents.write`, plus
`api.responses.write` when initial input is supplied. The CLI equivalents are
`rat-things sessions fork SESSION_ID --file fork.json` and
`rat-things sessions lineage SESSION_ID`.

Try the [two-theme fork demo](session-fork-demo.md) to compare two UI directions,
discard one child, and continue the other through the same API.

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
when a Turn completes, fails or is cancelled and the worker can capture output.
Abrupt worker loss cannot guarantee that final snapshot. The API supports up to
200 MiB per artifact and 500 MiB per output snapshot. These saved copies survive
environment expiry. Self-hosted environments do not implicitly publish their live
files as Artifacts. Saved bytes
remain subject to the deployment's [storage retention policy](durable-files.md#retained-output).

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
requests cannot choose an owner ID. Build the native console with `npm run console:build`. Running it uses the same transport:

```bash
RAT_THINGS_AGENTS_API_URL=DEPLOYMENT_BASE_URL AWS_REGION=DEPLOYMENT_REGION \
  npm run console:serve
```

## Application integrations

Signed provider events and schedules now submit canonical Session input. Provider
authentication, delivery, connection installation and scheduling remain separate
integration responsibilities. See [schedules and provider bindings](schedules.md).

Integration retries retain the saved Agent settings selected when Session
preparation began, including inherited MCP transport headers. Editing or deleting
that Agent does not change the pending Session's snapshot. A changed request
cannot resume the same pending preparation. Vault grants are still checked when
the Session launches work.

Publications select immutable Session artifact IDs through the separate
`POST /v1/sessions/{sessionId}/publications` application route. See
[sharing work](sharing-work.md). Session execution calls the private execution service directly.
