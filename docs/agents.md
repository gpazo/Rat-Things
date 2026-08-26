# Connect an agent to Rat Things

Command convention: this guide uses the installed `rat-things` shorthand. From a source checkout,
use `npm run rat-things --` before the same arguments, or run `npm run build && npm link` once.

Give an agent two things: the base URL of one Rat Things deployment and an authenticated way to
call it. The agent can discover everything else. Start with the deployment, not a remembered list of
routes and not the centrally hosted OpenAPI file.

Every accepted execution returns one durable Run immediately, whether it came from a raw API call,
a Thing, a schedule, a signed provider event, or an optional thread. The agent retains that Run ID,
then polls state or live events, answers ordinary input requests, and retrieves the result or files. A thread
adds continuity preparation; it does not introduce a second public receipt or execution model.

> Rat Things is an engineering preview, not a production-ready multi-tenant service. Start with
> narrow capabilities and read-only accounts. Browser use, broad egress, connected-account writes,
> and public sharing require an explicit host/user decision.

> Rat Things has no mid-Run approval layer. The host makes that decision by admitting a fixed
> capability envelope before launch; the agent is autonomous inside it. Outside the envelope, a
> tool is absent or the enforcing layer denies the operation—it never pauses for permission. See
> [the capability envelope](capability-envelope.md).

## Give this to an agent

Replace `RAT_THINGS_API_URL` with the independently operated deployment URL:

```text
You can use Rat Things at RAT_THINGS_API_URL.

1. Start with GET RAT_THINGS_API_URL/.well-known/rat-things.
2. Resolve its relative links against RAT_THINGS_API_URL. Treat that deployment's OpenAPI,
   schemas, capability profiles, and integration manifests as authoritative.
3. Use the authenticated principal supplied by the host. Never submit an owner ID or copy AWS,
   provider, S3, or MicroVM credentials into a Thing or run.
4. Prefer the Thing lifecycle for reusable work: create a draft, explain it, test it, publish the
   exact revision, then run or schedule the active revision.
5. For an accepted `202`, retain the returned Run ID and follow its `Location`, run state, or live
   events. Answer only ordinary outstanding input requests; never wait for or invent an approval
   route. Preserve `traceId` from any error.
6. Treat missing tools, forbidden resources, AWS `AccessDenied`, blocked URLs, and denied network
   destinations as final for that Run. Report the missing capability; do not search for another
   identity, credential, path, or route.
7. Use raw runs only when the task needs one-off control that does not belong in a reusable Thing.
```

The host must provide one of these authenticated calling surfaces:

- the `rat-things` CLI with `RAT_THINGS_API_URL`, AWS Region, and credentials already configured;
- an HTTP tool that can SigV4-sign requests for API Gateway's `execute-api` service; or
- a host-owned backend/tool that authenticates the user and calls Rat Things for that principal.

The public discovery, OpenAPI, and schema routes need no authentication. Owner-scoped routes do.
The included AWS deployment uses SigV4; a browser page must use a reviewed backend-for-frontend
rather than receiving AWS signing credentials.

## The smallest successful journey

1. `GET /.well-known/rat-things` and follow its installed contract links.
2. `GET /v1/capability-profiles` and `GET /v1/integrations/plugins` instead of assuming what is
   installed.
3. Validate a credential-free ThingSpec with the linked schema and `POST /v1/things`. For the first
   test, explicitly select the narrowest installed profile, `sandbox: "read-only"`, no
   network/search/browser, no accounts, and `deliver: [{"kind":"none"}]`; widen only for the
   stated task.
4. `GET /v1/things/{thingId}/explain?target=draft`. Repair every error diagnostic.
5. `POST /v1/things/{thingId}/test` with body `{}` and a semantic `Idempotency-Key`, then follow the
   returned run. Its Thing evidence must identify the same draft revision and `specHash` you tested.
6. Re-read the Thing, confirm the tested draft has not changed, then
   `POST /v1/things/{thingId}/publish` with
   `{"version":"1","expectedDraftRevision":TESTED_REVISION,"expectedSpecHash":"TESTED_HASH","testRunId":"SUCCEEDED_TEST_RUN_ID"}`.
7. `POST /v1/things/{thingId}/run` with body `{}` and a stable business-occurrence
   `Idempotency-Key`. A published
   `rate(...)` or `cron(...)` trigger is synchronized to Amazon EventBridge Scheduler automatically.
8. Only when the Thing needs an external service, reuse an owner-visible account from
   `GET /v1/integrations/connections` or ask the host to complete the manifest-declared
   credential/OAuth flow. Default new grants to `read-only`.

Profiles are ceilings across several independent dimensions, not a single ordered scale. Compare
their sandbox, network, search, browser, integration, and allowlist fields. If two profiles
are incomparable and either would grant unnecessary authority, ask the host/user instead of
guessing; the Thing request can then narrow the selected profile further.

The CLI performs the same sequence:

```bash
rat-things doctor --json
rat-things plugins
rat-things connections
rat-things thing-release --file thing.json
rat-things thing-run THING_ID --idempotency-key customer-review-2026-08-23
```

The release command still uses the public create, explain, test, Run polling, and exact-evidence
publish routes; it only removes copy/paste from the first-use path. Create and update move only the
draft pointer. Test uses that draft. Publish atomically selects one immutable revision as active.
Explicit production runs and Scheduler occurrences always pin that active revision. See
[Things](things.md) for lifecycle, schedules, permissions, and exact request examples.

## Go deeper only when the task needs it

| Need | Use | Important behavior |
| --- | --- | --- |
| Reusable cloud agent | `/v1/things` | Recommended facade; immutable draft/active revisions |
| One-off advanced execution | `POST /v1/runs` | Direct control of prompt, model, repository, capabilities, accounts, execution, and delivery |
| Browser, web search, skills, apps, or MCP | ThingSpec or run `agent.capabilities` | Deployment profile remains the ceiling; requested capabilities can narrow, never widen it |
| Several external accounts | Integration manifests, connections, grants, and connection sets | Provider authority, Rat grant, profile, and Thing/run selection are intersected |
| Active progress and ordinary input | Run events, response, steer, and interrupt routes | Available only while the exact run has an active MicroVM; responses cannot widen authority |
| Durable multi-turn work | `POST /v1/runs` with `thread.key`, plus conversation status/artifact routes | The same Run receipt is returned immediately; the mailbox is always durable, and S3 Files adds workspace/native-thread restoration on replacement compute |
| Generated files | Run or conversation artifact routes | Returns owner-checked metadata and short-lived access URLs |
| Shareable file, site, or video | Run or conversation publication routes | Publishing is explicit and produces a time-bounded bearer URL |
| Provider event ingress | Signed GitHub, GitLab, Teams, or Slack routes | Separate authenticated ingress into the shared run backend; not a Thing trigger in v1 |
| Lower-level interval compatibility | `/v1/routines` | Still installed, but use scheduled Things for new reusable work |
| Failure diagnosis | Thing explanation, stable error envelope, and `traceId` | Follow [diagnostics](diagnostics.md) before infrastructure mutation |

### Advanced run configuration

Use the linked OpenAPI `RunRequest` schema rather than reconstructing it from this summary. Its
advanced `agent.capabilities` fields currently include:

- a deployment-installed capability profile;
- command networking and web search;
- headless browser computer use;
- installed Codex skills;
- requested apps; and
- configured MCP servers.

The raw run API is not more privileged than a Thing. The same owner boundary, fixed capability
envelope, connection grants, validation, MicroVM isolation, idempotency, and durable evidence apply.
Requested MCP names are force-enabled; they are not an exact deny-list for servers inherited from a
project configuration. Keep the base MicroVM configuration empty when exact MCP control matters.

There is no owner-facing skill/app/MCP inventory route in v1. A profile allowlist constrains names
when present; an omitted allowlist means the profile adds no name restriction, not that a requested
name is installed. Use host-supplied names and let runtime validation fail closed rather than
guessing identifiers.

### Control an active run

After any Thing test/run, conversation message, provider event, or raw run returns a run ID:

1. `GET /v1/runs/{runId}` for durable state.
2. `GET /v1/runs/{runId}/events?after=0&limit=100` for ordered live events and outstanding requests.
3. Use the returned request ID with the response route only for ordinary requested data; never
   invent a request ID or treat a response as authorization.
4. Use steer or interrupt only while the run is active.
5. At terminal state, read output and list artifacts. Create an artifact publication/share only
   when the user requested sharing; this is distinct from publishing a tested Thing revision as active.

Live events are bounded and ephemeral. The terminal event artifact is the durable audit source.
There is no human-approval inbox because there is no interactive approval flow. Every admitted
capability must be safe for autonomous use for the full Run. If a task needs a human checkpoint,
split it into a read-only preparation Run and a separately submitted execution Run with a reviewed,
narrow envelope.

If a required capability is unavailable, report the missing profile/tool/account/operation and ask
the host to configure a future Run or Thing revision. “Unavailable” means that the capability is
absent or the responsible layer rejects it—for example, a tool is omitted, AWS returns
`AccessDenied`, a URL is blocked, or the broker denies an operation before reading its credential.
It never means that an approval is pending. Never search for another owner, credential, filesystem
path, or network route.
After interruption, do not automatically repeat a consequential external call whose result is
unknown; reconcile durable/provider evidence first.

## Source-of-truth order

When sources disagree, use this order:

1. the installed `/.well-known/rat-things` response;
2. the installed `/openapi.json` and linked JSON Schemas;
3. installed capability profiles and integration manifests;
4. current runtime responses and stable errors;
5. this centrally hosted guide and `llms.txt` navigation; and
6. `llms-full.txt` only when broad implementation or operational context is actually needed.

Do not load the complete corpus for a simple Thing run. Progressive discovery keeps the agent's
context small and prevents planned or historical material from overriding installed behavior.
Schema string lengths are character preflight limits; the runtime also enforces documented UTF-8
byte limits, so multibyte input can still be rejected.

Discovery describes authentication on the installed Rat Things endpoint. A host-owned backend tool
may hide that transport from the agent while preserving its authenticated principal. The published
v1 direct-client contract is SigV4; JWT or another replacement direct transport is not represented
by v1 discovery/OpenAPI and requires a separately maintained contract.

## Failure rules

- `400 invalid_request`: correct the request; do not retry it unchanged.
- `403 forbidden`: repair authentication or ownership; never search for another owner's IDs.
- `404 not_found`: refresh discovery and owner-visible state.
- `409 conflict`: refresh the Thing/run and reconcile the stale lifecycle or active-interaction state.
- `503 integration_unavailable`: retry with bounded backoff while keeping credentials out of logs.
- `500 internal_error`: preserve `traceId` and retry only when the envelope says `retryable: true`.

Thing and connection creation do not have idempotency keys in v1. If a create response is lost,
list owner-visible state and reconcile by stable metadata (and a Thing's `specHash`) before retrying;
never blindly create another account connection or Thing.

Continue with the [control API](api.md) for every route, [integrations and permissions](plugins.md)
for account onboarding, [browser computer use](browser-computer-use.md) for its exact current limits,
[durable conversations](conversations.md), and [files and publications](sharing-work.md).
