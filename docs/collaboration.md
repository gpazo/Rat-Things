# Work together in one Session

A team space contains shared Agents and Sessions. Everyone with access follows the
same conversation, tool activity and results. Collaborators can contribute while
the agent works; their messages retain their identities and durable processing order. The
agent keeps working when all participants disconnect. Use separate Sessions for
separate goals.

Space roles govern access to every Agent and Session in that space. There is no
additional private or restricted Session setting. Sharing a local Session means
choosing its destination space; everyone in that space can then use their role
to read or contribute.

## Roles and execution authority

| Space role | What it permits |
| --- | --- |
| Viewer | Read Agents, Sessions, saved progress and artifacts |
| Collaborator | Viewer access, plus contribute input and create work using admitted Agent capabilities |
| Controller | Collaborator access, plus cancel work |
| Manager | Controller access, plus manage configuration, membership and execution roles |
| No binding | No access to the space's resources |

An identity is an OIDC issuer and subject pair. Display names help attribution but
do not grant permission. A space selector such as `X-Rat-Space` selects where to
work; it never grants access by itself. Access also requires the token's API scopes.

An Agent's execution role is separate from a person's space role. Managers define
the permitted models, tools, environments, Vaults and subagent limits, then admit
Agents under that ceiling. A collaborator cannot
change those permissions by supplying an inline Agent or a broader environment.

Each Session keeps its admitted execution capabilities. Editing a role or Agent
does not add capabilities to an existing Session. Create a new Session when the
task needs more authority. The agent acts autonomously inside its envelope;
there is no approval prompt that can widen it during execution.

Removing a participant blocks new access and new submissions. Open activity
streams recheck access, including while idle, and close when access expires or is
removed. Deleting a Session also closes its activity streams. Closing a viewer's
stream stops that viewer's polling; it does not cancel the agent's work.
A request accepted before removal remains durable and can finish. To
stop that work, a controller cancels it separately. Removing access cannot recall
content already read or remove contributions already included in model context.

## Connect from the desktop

Use the workspace menu to connect to your team's Agents API endpoint. Sign in
through the configured identity provider, then choose a space. Your administrator
must grant your verified identity a role before that space becomes available.
Sending someone the endpoint does not grant access or send an invitation email.

Open a Session to follow its progress. Collaborators can send messages while a
Turn is active, and the agent sees each participant's contribution. Viewer controls
remain read-only. Reconnecting loads saved activity and resumes from a durable
cursor; reconnecting does not submit the task again.

The composer keeps the current Turn state visible: queued, working, waiting,
completed, failed or cancelled. **Activity** opens recent saved tool and execution
updates; the full history stays in the conversation. These are saved observations,
not a percentage-complete estimate. **Details** contains the runtime, model and
raw Turn status. Use **Shared workspace** beside the Session title to review work,
and **← Conversation** to return to the full conversation.

Each contributor has a color within the Session. The same identity keeps that color
across clients and reconnects; new contributors receive unused colors. Names stay
visible beside messages and author badges, so people with similar names or colors
can still be identified. Message bodies use neutral text for reading; reply context
retains the original author’s color. Colors describe authorship, not roles or authority. Imported author
claims remain labelled as imported and are distinct from verified team identities.

While someone edits the composer, other participants see “Maya is typing…” or the
two participants' names. With three or more, the desktop shows “Several people are
typing…”; hover to see the names. Only the typing signal is shared, never unfinished
text. It clears when typing stops, the composer loses focus, or the message is sent.
An interrupted connection can leave the indicator visible for up to six seconds.
Typing does not pause the agent, change feedback batching, or start a Turn.

Use **Reply** beside a message to respond to that point. The composer shows a preview
of the selected message; the **×** button removes the reference without discarding
your draft. Sent replies appear in the main conversation with the original author
and a quoted preview. Click the preview to return to the original message. Replying
works for participant and agent messages, including feedback awaiting dispatch.
It also works in a local single-player Session.

The agent receives the reply reference, original author and a bounded quote alongside
your contribution. Saved input receipts retain that relationship as part of the
Session's feedback history. A reply is ordinary input under your current role; it
does not create a separate subthread or expand the agent's capabilities.

Contributions are saved and made visible before the agent receives them. When
messages arrive together, the service collects them until 300 ms of quiet, with
at most one second of intentional waiting from the oldest pending contribution.
Storage, dispatch and model latency add to that window. Large bursts split into
bounded batches. Every message keeps its own author and receipt; batching does
not summarize messages or resolve disagreement between collaborators.

An active agent keeps working while feedback collects, then receives the batch
as steering. A controller's cancellation bypasses the collection delay. Input
acceptance means the contribution is durable, not that the model has processed it.

The desktop's host helper owns the browser authorization-code flow, PKCE proof,
token renewal and local credential storage. Team login tokens are never placed
in a Session, workspace snapshot or worker. Signing out removes the saved team
connection from this computer.

Saved team connections live in `~/.rat-things/connections` in user-owned private
files. Protect the host account and use device encryption for protection at rest.
This credential store is separate from the Session's execution workspace.

## Share local work with a team

Start alone in **This computer**, then use **Share** and choose a signed-in team
space. The destination must support the Session's model, runtime and unchanged
capabilities. Sharing does not select a replacement Agent or silently change the
model. Source Vault credentials, source-specific tools and environment variables
that cannot be carried safely require a compatible new Session.

The logical model stays the same across providers. At the Codex execution
boundary, known OpenAI models use Bedrock's `openai.` namespace when needed—for
example, `gpt-6-astra` becomes `openai.gpt-6-astra` on the wire. Unsupported models
fail; there is no model fallback.

Sharing waits for accepted work to reach a completed-Turn boundary and stops the
local executor before taking a workspace snapshot. It preserves the logical
Session identity, Agent configuration, completed Turns, Items, usage, artifacts
and workspace files. The destination recovers a fresh private harness from saved
context. Native processes and subscription logins do not move, and completed
commands or setup are not replayed.

Workspace transfer excludes the harness's sandbox lock directory and transfer
staging files. These belong to each executor and are recreated there; they are
not part of the team's working files.

The first release accepts up to 10,000 workspace entries, 100 MiB of uncompressed
content and a 50 MiB archive. The saved history and configuration manifest must
fit within 3 MiB, and each saved artifact must be at most 3 MiB. Regular files,
empty directories, executable permissions and internal relative symlinks are
preserved. External symlinks and special files are rejected.

Once local execution has been released, this computer cannot resume it. The
hosted Session becomes the place to continue, even if an activation response is
lost. Retry the same Share operation after an interruption; its saved receipt
reuses the original identity and snapshot. Restarting the local service never
creates a second executor for a released Session.

Before release, you can cancel an interrupted or incompatible Share and continue
locally. Cancellation waits for the coordinator to stop and, if staging began,
for the destination to retire that transfer. It then invalidates the Share
operation and removes its source fence. If the destination cannot be reached,
retry cancellation when it is available. An automatic timeout or network error
never returns execution to the source.

The existing **Copy to AWS** workflow creates a separate Session and keeps the
local original. Use Share when the team should continue the same work.

## Configure a deployment

Configure a public OIDC client with authorization-code flow and PKCE S256. Register
the exact loopback callback, for example `http://127.0.0.1:38173/callback`. The
desktop uses an external browser; it does not collect identity-provider passwords.

Pass trusted provider settings to the Terraform module:

```hcl
oidc_providers = [{
  id                    = "company"
  issuer                = "https://identity.example.com"
  jwksUri               = "https://identity.example.com/.well-known/jwks.json"
  clientId              = "rat-things-desktop"
  profile               = "jwt_access"
  audience              = "https://agents.example.com"
  authorizationEndpoint = "https://identity.example.com/authorize"
  tokenEndpoint         = "https://identity.example.com/oauth/token"
  redirectUri           = "http://127.0.0.1:38173/callback"
  scopes                = ["openid", "profile", "rat-things"]
  requiredScopes        = ["rat-things"]
}]
```

Use your provider's actual endpoints, audience and scope names. `jwt_access`
requires an access JWT with `typ: at+jwt` and the configured audience. For Amazon
Cognito, use `profile = "cognito_access"`, the user-pool issuer and JWKS URL, and
the app client ID. Cognito tokens must have `token_use: access` and the configured
`client_id`. ID tokens are never accepted as API credentials.

`scopes` configures the browser login request. `requiredScopes` defines scopes
that an API access token must contain. Optional `apiScopes` restricts the
provider's maximum Rat Things API scopes; recognized `api.*` scopes in a token
further restrict access. Space role checks still apply.

The module exports `shared_agents_api_base_url`. This Lambda Web Function
authenticates OIDC access tokens in the application and serves concurrent requests
and progress streams. The IAM operator API handles token issuance, space bootstrap,
and deployment administration. An empty provider list does not create a team
endpoint. Do not disable application authentication or use the local owner-header
fixture as a team deployment.

## Bootstrap a space and admit an Agent

An IAM-authenticated operator uses the control API's `api_endpoint` output to
create a space and assign its initial manager by exact verified issuer and subject:

```http
POST /v1/rat/spaces
Content-Type: application/json

{
  "name": "Engineering",
  "manager": {
    "issuer": "https://identity.example.com",
    "subject": "manager-subject",
    "label": "Alex"
  }
}
```

Use that space's returned ID in `X-Rat-Space` on authenticated team requests. A
manager grants another verified identity access with
`POST /v1/rat/spaces/{space_id}/bindings`:

```json
{
  "issuer": "https://identity.example.com",
  "subject": "collaborator-subject",
  "role": "collaborator",
  "label": "Sam"
}
```

`GET /v1/rat/me` returns the caller's verified actor identity. Do not substitute an
email address or display name for the identity provider's subject. Delete a
binding using `DELETE /v1/rat/spaces/{space_id}/bindings/{actor_id}`.

Before collaborators start work, a manager defines an execution role with
`PUT /v1/rat/spaces/{space_id}/execution-roles/{role_id}`. A conversation-only
example is:

```json
{
  "name": "Team conversations",
  "models": ["YOUR_DEPLOYED_MODEL_ID"],
  "tools": [],
  "environments": [{ "type": "none" }],
  "vault_ids": [],
  "capability_profile_ids": [],
  "connection_grant_ids": []
}
```

`capability_profile_ids` and `connection_grant_ids` are reserved and must be empty
in this release. Run-level capability profiles and connection grants are not
Session execution-role controls.

Create a saved Agent through the normal Agents API, then assign it with
`PUT /v1/rat/agents/{agent_id}/workload` and
`{"execution_role_id":"YOUR_ROLE_ID"}`. Admission pins the saved configuration;
after an Agent edit, assign its revised configuration before collaborators use
it. A shared local Agent is checked against the destination ceiling as part of
Share. Its original identity and configuration must not collide with a different
Agent in the space.

If the destination already assigns that Agent an execution role, Share must also
fit that assignment. A broader role elsewhere in the space does not override it.
Forking creates a new Session and checks the current execution ceiling; an older
Session's admitted authority does not bypass a role that has since been narrowed.

## API clients and activity

Send an OIDC access token as `Authorization: Bearer ...` and the selected space
as `X-Rat-Space`. The ordinary Agents API resources keep their existing shapes.
Rat Things extensions live under `/v1/rat`:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/rat/me` | Verified caller identity |
| `GET /v1/rat/spaces` | Accessible spaces |
| `GET /v1/rat/sessions/{id}/activity` | Coherent Session, Turn, Item and attributed-input snapshot with cursor |
| `GET /v1/rat/sessions/{id}/activity/events` | Saved activity and ephemeral typing over SSE |
| `POST /v1/rat/sessions/{id}/messages` | Attributed text with an optional reply target |
| `POST /v1/rat/sessions/{id}/typing` | Refresh or clear the caller’s typing signal |
| `POST /v1/rat/sessions/{id}/workspace/feedback` | Comment on, resolve or reopen an artifact annotation |
| `GET /v1/rat/sessions/{id}/workspace/browser` | View the shared browser’s current frame |
| `POST /v1/rat/sessions/{id}/workspace/browser` | Navigate or interact with the shared browser |
| `POST /v1/rat/sessions/{id}/workspace/browser/capture` | Preserve an exact displayed frame for annotation |
| `POST /v1/rat/shares` | Stage a nonrunnable transfer |
| `POST /v1/rat/shares/{id}/activate` | Activate a staged transfer after source release |

Activity input records include actor, acceptance sequence, status and associated
message and Turn IDs. Reconnect with the snapshot cursor in `Last-Event-ID`.
While a contribution awaits dispatch, `pending_inputs` contains its messages,
and its input receipt has an empty `turn_ids` array. Once assigned to a Turn,
those same message IDs appear in `items`. Render pending messages immediately
and deduplicate by message ID. Pending display positions are provisional;
materialized receipt sequences define durable processing order. Simultaneous
network requests have no guaranteed wall-clock arrival order.

Activity streams coalesce intermediate snapshots and resume with the latest
saved state; treat their cursors as opaque. Use the ordinary Agents event stream
when an application needs every individual event. The desktop keeps its stream
open across updates and periodically refreshes access and recovery snapshots.
Projection work can be shared by viewers in the same server process; separate
Lambda invocations still perform their own polling. Immutable history hydration
is cached with memory bounds, while authorization and revocation checks remain
current for each viewer.
Source history carried by Share is marked **imported**. Its reported identities
provide context and are not treated as identities verified by the team deployment.
If a cursor is no longer available, obtain a fresh snapshot before resubscribing.
Use the same `Idempotency-Key` when retrying an ambiguous submission. Keys are
scoped to the authenticated actor, so two participants using the same client key
do not overwrite each other's contributions.

An accepted contribution can cross a Turn boundary. If the worker confirms that
the original Turn ended before receiving it, the service carries that contribution
into a following Turn with the same message identity and attribution. An uncertain
delivery outcome is not permission to replay the work.

The local Share coordinator owns staging and activation. Applications should use
the desktop flow or `POST /v1/workspace/shares` on the authenticated local service
with `session_id`, `endpoint`, `space_id` and `connection_id`. A retry uses the
same saved operation ID. Avoid implementing activation as an uncoordinated copy.

Space authorization is an application boundary within an owner-operated Rat
Things deployment. It does not change the engineering preview's broader
[multi-tenant limitations](status-and-roadmap.md#known-gaps). Audit history remains
under the space's owner scope after Agent or Session deletion; access still
requires the appropriate current role.

### Replies and typing for client authors

Post `{"text":"Test a clean setup too.","reply_to":"msg_original"}` to the messages
endpoint, with an `Idempotency-Key` retained across retries. Omit `reply_to` for a
normal message. The server verifies that the target is a message in this Session
and resolves its author and quote; clients cannot supply or override either.
The accepted receipt's `reply` includes `message_id`, `role`, optional actor and
provenance, a quote limited to 2,000 characters, and `truncated`. Render the quote as
text. Preserve the message ID to navigate to the full original. Changed reply
targets require a new idempotency key, just like changed message text.

Activity receipts include `participant: {key, actor, color}`. Render the assigned
hex color alongside the author name; do not assign colors independently in each
client. Imported identities have separate keys. The base Agents API Item shapes
remain unchanged.

For team typing, post `{"client_id":"unique-window-id","sequence":1,"typing":true}`.
Use a fresh client ID for each app/window lifetime, increase `sequence` for every
update, and refresh at most once every two seconds while the person is editing.
Send `typing:false` on send, blur or navigation. Expiry is six seconds; older
sequence numbers cannot revive a stopped indicator. Multiple windows belonging to
one person appear as one typist. Both write endpoints require collaborator access;
viewers receive typing indicators but cannot publish them.

The activity SSE connection sends lightweight `rat.session.typing` events with
`typing: [{participant, expires_at}]` and `server_time`. Replace the previous typing
list, exclude the viewing user's verified identity, and expire entries locally
using the difference between `expires_at` and `server_time`. These events have no
durable cursor: keep the last activity cursor for reconnects. Typing is not replayed,
included in model input, or retained as feedback history. The service keeps a
short-lived sequence record to reject delayed updates. No draft text is accepted.

## Review artifacts together

Open **Shared workspace** in a Session. The live browser opens when available;
otherwise choose a saved artifact. In a wide window, the work stays beside a
discussion pane. Use **Conversation** for the Session's messages and **Feedback**
for annotations on the selected work. Both reach the same agent. In a narrower
window, **Work** and **Discussion** give each view room to read and interact.
Switching views preserves unsent messages and annotation drafts; it does not send them.

Images can carry
point or region annotations: choose **Add comment**, click a location or drag a
rectangle, and send feedback. You can also comment on the whole file. Each
annotation has a discussion, author names and the same participant colors as the
conversation. **Resolve** closes a discussion; **Show resolved** lets you find it
and **Reopen** brings it back.

Feedback appears in the shared conversation and is delivered to the agent with
its author, artifact version and selected context. Image and browser feedback
includes the referenced image. A newer output never moves an existing annotation
onto different content. Files saved under `/workspace/outputs` become immutable
artifacts when the agent's Turn ends. The desktop previews PNG, JPEG, WebP and
UTF-8 text; save other formats to open them with another application. Preview size
is bounded; a file can still receive whole-file feedback without a preview.

This uses the Session's existing roles. Viewers can follow artifacts and feedback;
collaborators can annotate, reply, resolve and reopen. Imported author names remain
reported source identities, rather than identities verified by the current space.

## One live browser

Select **Shared live browser** when creating an Agent or a new inline Session.
Use a Rat Things Linux worker and an image-capable model. The same browser is
available to Codex and Pi. This is a fixed capability: an existing Session without
the grant needs to be replaced by a new Session to gain browser access.
Team-space execution roles currently admit Codex Sessions; Pi browser use is
available outside that team admission path.

Rat Things runs its own Chromium process in the isolated worker, locally or in
your AWS account. No external browser hosting service is involved. The worker
owns the browser's lifecycle; the desktop and agent tools are clients of that
browser. The public Agents API calls this environment `openai_hosted`; in Rat
Things it means the worker provisioned by your deployment, not execution in an
OpenAI-hosted browser.

The worker initializes the browser before starting agent work. A cold worker can
take longer to become ready; browser reads return a temporary unavailable response
during initialization. Once ready, the browser remains available between Turns.

Choose **Live browser** in the shared workspace. Everyone sees the same page,
viewport and navigation. Collaborators can enter a URL, click, scroll, and type
into the focused field. Viewers can watch. Actions from people and the agent use
one ordered queue. If someone changes the browser before your action arrives,
refresh and try again against the current view. The browser uses the Session's
existing network policy; a browser grant does not add network destinations.

To preview generated web content, the agent can navigate to
`https://rat-artifacts.invalid/index.html` after writing
`/workspace/outputs/index.html`. This address serves files from that worker's
outputs directory. It works with network access disabled and is never a public
website. Symlinks cannot expose files outside outputs.

**Add comment** captures the exact frame you were viewing. Your annotation view
stays on that capture while other participants continue browsing. **Return to live
view** rejoins the current page. Captures attached to feedback remain part of the
Session's durable history even if the browser later navigates or its worker stops.

The initial browser supports one page, a fixed viewport and periodically refreshed
images. Pop-up tabs, downloads, file uploads, WebGL and WebSocket applications are not
supported. A replaced worker starts a new browser generation; old actions cannot
be replayed into it. Captured feedback survives, but live forms and JavaScript
state are not transferred to the replacement browser.

### Workspace API clients

Enable the browser by including this reserved function declaration in the Agent's
`tools` when the Session is created:

```json
{
  "type": "function",
  "name": "rat_things_browser",
  "description": "Use the live browser shared with this Session.",
  "parameters": {"type": "object", "properties": {}, "additionalProperties": false}
}
```

Rat Things resolves this grant into the harness's browser tool. Clients do not
fulfil it as an application function call. The ordinary Agents API DTOs are
unchanged.

Activity includes `workspace_threads`, with an immutable `target`, `resolved`
state and attributed `comments`, and `browser_available`. Activity includes image
metadata rather than inline image bytes. When `target.image_available` is true,
read the saved image with
`GET /v1/rat/sessions/{session_id}/workspace/threads/{thread_id}/image`. This returns
the original image bytes and media type, requires Session read access, and must not
be cached. The desktop fetches saved browser images when you select their feedback.

To start an annotation,
post the following to the feedback endpoint with an actor-scoped
`Idempotency-Key`. The service resolves the artifact version; clients cannot
supply an image or substitute a different version:

```json
{
  "text": "Make the primary action clearer.",
  "target": {
    "kind": "artifact",
    "id": "art_example",
    "anchor": {"type": "point", "x": 0.6, "y": 0.3}
  }
}
```

Anchors are whole-item (`{"type":"item"}`), normalized points, normalized regions
(with `width` and `height`), or text selections (`start`, `end`, `quote`, using
UTF-16 offsets into the original text). Replies use `thread_id` instead of
`target`. Resolving or reopening also supplies `thread_id`, `text` and
`action: "resolve"` or `"reopen"`. Keep the same request key when retrying an
uncertain submission; use a new key for each intentional new contribution.

A browser frame contains `epoch`, `revision`, `frame_id`, dimensions, a base64 JPEG,
URL, title and bounded page text. A browser action supplies `epoch`, `revision`
and `operation`, with an `Idempotency-Key`. Operations include `navigate`, `click`,
`type`, `key`, `scroll`, `back`, `forward` and `reload`. Coordinates are normalized
to the displayed viewport. Do not automatically replay rejected actions against a
newer revision. Authorized frame reads can share capture work within a server
process; permission checks are performed for each request.

To annotate a browser frame, first post `{"frame_id":"..."}` to the capture
endpoint. Use its returned `id` as a feedback target with `kind: "browser"`.
Capture a recently displayed frame before it leaves the worker's bounded frame
cache. New annotations require a capture less than an hour old. Already accepted
feedback remains readable and can be retried with the same key and content after
that capture expires. Replies to its annotation thread use the saved context.
Retries still require current contribution access; changing content under an
accepted key returns an idempotency conflict.
