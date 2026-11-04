# Inspect configuration and tool decisions

Use configuration history to find the settings a Session received, and tool
authorization records to understand why the trusted host allowed or denied a
service MCP call. These records belong to the authenticated owner. They remain
readable after the corresponding Agent or Session is deleted.

Configuration history works in local and AWS workspaces. Tool authorization
records cover HTTP MCP tools with `connection_origin: "service"` in AWS workers.
Local Sessions do not support MCP. The records cover MCP `tools/call` requests;
initialization, discovery, resource reads, and prompt retrieval do not produce
tool authorization records. Shell commands, environment-origin MCP,
application-resolved functions, and delivery integrations are also outside this
coverage.

## Find the configuration used by a Session

List the Session's retained configurations, then retrieve the revision you want:

```bash
rat-things sessions configurations sess_123 --order asc
rat-things sessions configurations sess_123 1
```

Each record contains a resolved configuration, a digest, its recording time,
the changing actor when known, and `changedPaths`. The paths identify changed
fields using JSON Pointer notation. Compare the corresponding snapshots to see
the previous and replacement values. Revision numbers are identifiers; they may
have gaps.

For Sessions created from a saved Agent, `sourceAgent` identifies the exact Agent
revision read during preparation. Inline Sessions retain their resolved settings
without a saved Agent reference. A fork retains its own configuration and its
source Session reference. An imported conversation starts with a destination
configuration; its history is not evidence of execution in the destination.

```bash
rat-things agents revisions agent_123 --order asc
rat-things agents revisions agent_123 2
```

Creating, updating, or deleting a saved Agent retains a revision in the same
atomic write as the change. Deletion retains a tombstone with `snapshot: null`.
Editing a saved Agent does not change existing Sessions. Session updates retain
their new resolved settings, and accepted Turns keep the configuration reference
they received. The admitted capability envelope remains fixed for that Session.

`actor.kind: "owner"` identifies the authenticated owner, not necessarily a named
human. System changes use `system`. HTTP mutations include the server's request
ID when available. An older resource first observed by the history system has
`change: "legacy_observed"` and an unknown changing actor. Earlier overwritten
revisions cannot be reconstructed. Older Sessions never acquire a reference to
today's Agent definition as a substitute for their original configuration.

## Inspect a service MCP decision

```bash
rat-things sessions authorizations sess_123 --order asc
rat-things sessions authorizations sess_123 authz_123
```

A record contains the requested tool, its server label, the admitted tool
allowlist and policy digest, the Session configuration reference, the decision,
and any observed dispatch outcome. It also identifies the executing Run,
generation, and runtime epoch. The Agent ID names the Session's configured Agent.
Arguments, tool output, transport headers, secret
values, and secret-store references are excluded.

Optional actor and credential-subject fields describe the Run's initiating
provenance. They do not identify the author of every later steering message or
prove who caused an individual tool call.

The host records the decision before sending the tool request. If it cannot
confirm that the decision was saved, it does not dispatch the request. An
allowlist denial does not read a live Vault credential for that request. A batch
containing a denied call is not forwarded; otherwise admitted members receive
`batch_denied` records. Batches are limited to 32 messages; nested or malformed
batches are rejected before dispatch.

Credential evidence distinguishes a live Vault check, an inline Session
snapshot, and a connection without credentials. Vault evidence identifies the
checked Vault and credential revisions. Inspect those revisions with:

```bash
rat-things vaults revisions vault_123
rat-things vaults credential-revisions vault_123 cred_123
rat-things vaults credential-revisions vault_123 cred_123 3
```

Vault history retains public credential metadata and active or archived state.
It does not expose tokens or refresh secrets. Rotation, archive, and internal
refresh coordination can produce revisions with unchanged public settings.
Existing live checks still enforce active credentials and their configured
destination. Revocation can race a request already admitted for dispatch; an
audit record does not undo an external effect.

Read outcomes according to what the host observed:

| Outcome | Meaning |
| --- | --- |
| `not_dispatched` | The recorded attempt did not proceed to the upstream request. |
| `response_received` | The host observed an HTTP response. Its status does not establish that the tool's business operation succeeded. `toolResult: "unobserved"` means no tool-level result was established. |
| `unknown` | The host could not establish an outcome, or no outcome record was saved. The external operation may have happened. |

A credential refresh after HTTP 401 creates a new attempt with new authorization
evidence before the retry. Attempts share a host-generated `requestId`. A failed
outcome write does not trigger another tool request. Authorization records are an
audit trail, not an exactly-once guarantee for remote effects.

Turn attribution is separate from authorization. `single_active_turn` records
the sole active Turn observed by the host at that point. It is context, not an
exact native tool-item match. Overlapping root and subagent work can produce
`unresolved` attribution. Session, Run, and generation identity remain available.
MCP request IDs and guest metadata never choose those identities.

## Export authorization records to OpenTelemetry

```bash
rat-things sessions authorization-traces sess_123 --output authorizations.otlp.json
curl --fail-with-body http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' --data-binary @authorizations.otlp.json
```

The CLI combines every available page into OTLP JSON. Configure authentication
for your collector separately. Rat Things does not automatically forward these
records or store collector credentials.

Authorization spans use stable IDs derived from the owner, Session, and receipt.
They carry the receipt ID, policy digest, configuration and credential revision
references, decision, execution identity, and observed outcome. They exclude
configuration bodies, actor details, URLs, arguments, and output. Filter on
`rat_things.authorization.decision`, `rat_things.outcome`, or
`rat_things.run.id` to investigate activity, then retrieve the full owner-scoped
record by `rat_things.authorization.id`.

These spans have independent trace identities. They are not attached to a native
tool span by a guessed match. A contextual Turn appears as
`rat_things.context.turn_id` with an attribution attribute. Use
[`sessions traces`](agents-api.md#export-traces-to-your-own-tools) separately for
the Session's execution hierarchy and model usage. Authorization export is
available as records arrive and does not wait for a root Turn to finish.

## API access and retention

These read-only Rat Things endpoints extend the API without changing the upstream
Agent, Session, or Turn resource shapes:

| Endpoint after `/v1` | Required read scope |
| --- | --- |
| `/agents/{agent_id}/revisions[/{revision}]` | `api.agents.read` |
| `/agents/sessions/{session_id}/configurations[/{revision}]` | `api.agents.read` |
| `/agents/sessions/{session_id}/authorizations[/{authorization_id}]` | `api.agents.read` |
| `/agents/sessions/{session_id}/authorizations/otlp` | `api.traces.read` or `api.agents.read` |
| `/vaults/{vault_id}/revisions[/{revision}]` | `api.vaults.read` |
| `/vaults/{vault_id}/credentials/{credential_id}/revisions[/{revision}]` | `api.vaults.read` |

Bracketed path segments are optional. Lists accept `limit` from 1 to 100, `order`
as `asc` or `desc`, and `after`. When `has_more` is true, pass `last_id` as the
next `after`. Exact-revision reads accept the revision number; pagination uses
the record ID returned by the list. The OTLP list returns `data[].otlp`.

The records use the workspace's encrypted storage and have no automatic
per-record expiry. Deleting a public resource does not erase this history.
Include it in your storage capacity, access, and backup policies. Deployment or
storage deletion can remove it. The records are immutable through the
application, but this is not a write-once archive protected against storage
administrators. Old workers and previously completed calls have no retroactive
authorization records.
