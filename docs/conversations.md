# Durable conversations

Rat Things has a provider-neutral persistence model for long-running conversations. It adopts the
durable-mailbox invariants of Sentry Junior while using AWS-native storage: DynamoDB is the bounded
coordination plane, the artifact bucket is the immutable body/event/checkpoint/result plane, and S3
Files optionally exposes durable Codex app-server state and workspaces as a mounted filesystem.

Every accepted input first becomes one durable Run. When `POST /v1/runs` includes `thread.key`, or a
verified provider event maps to a thread, trusted orchestration binds that same Run to the mailbox
and sends an SQS wake-up. A coordinator attaches replayable context as `executionInput`, resumes a
suspended MicroVM and Codex thread when possible, and folds terminal output back into history. With
no thread binding, the same Run wakes the dispatcher directly. There is one public receipt and one
Run lifecycle in both cases.

## Conversation identity and concurrency

The provider's existing thread is the user-facing conversation boundary. In Microsoft Teams, a new
top-level post starts a new Rat Things conversation and replies in that thread add turns to it. No
session command or special `new:` syntax is required.

Different provider threads use different DynamoDB partitions and S3 Files directories, so they may
run concurrently. Turns within one thread are serialized. A fenced DynamoDB lease ensures that only
one MicroVM at a time owns the conversation and opens its Codex SQLite state.

## Invariants

- The mailbox, not SQS, is the source of truth. Queue messages only wake a coordinator.
- Each conversation has at most one renewable worker lease and one active turn.
- The lease fences filesystem ownership: only one MicroVM may mount and open a conversation's Codex
  SQLite state at a time. Different conversations remain independently concurrent.
- Every mutating turn operation is fenced by the current lease token.
- `interrupt` messages sort ahead of `defer` messages without losing arrival order within a class.
- Checkpointing moves a turn to `awaiting_resume` and releases its lease. Another worker can acquire
  a new lease and resume the same turn at the next slice.
- DynamoDB stores only bounded records and previews. Full message bodies, event payloads,
  checkpoints, results, and published files live in S3 behind checksummed references.
- `.rat-things/artifacts/` is reconciled from the committed conversation catalog before each run;
  successful changes replace that catalog, while failed runs cannot mutate its durable view.
- User attachments are checksummed into the same encrypted artifact store, bound to the accepted
  Run by a private manifest, and merged into the catalog while the coordinator holds the lease.
  They are therefore available at `.rat-things/artifacts/uploads/...` even after crash repair or a
  replacement MicroVM; base64 transport bytes and S3 coordinates never enter the public transcript.
- Provider source, destination, actor, owner, and credential-subject contexts remain distinct.
- A run is attached to its turn before its dispatcher wake-up. A repeated conversation wake repairs
  the attach/enqueue crash window without creating a second semantic run.
- A terminal conversation VM is suspended before the turn is finalized, so failed suspension is
  retryable while the turn remains active.

## AWS mapping

| Conversation concern | AWS representation |
| --- | --- |
| Mailbox and conversation state | One DynamoDB partition per hashed conversation ID |
| Message priority | `conversation-work-index`, ordered by delivery class, time, and message hash |
| Owner conversation list | `owner-created-index`, newest first; opaque API IDs are conversation hashes |
| Worker ownership | Lease token and expiry on the conversation metadata item |
| Active turn and resume slice | Durable turn item in the same partition |
| Coordinator wake-up | Encrypted SQS queue plus Lambda event-source mapping |
| Execution continuation | Expiring MicroVM ID/state plus durable Codex thread ID on conversation metadata |
| Native Codex/workspace state | S3 Files access point rooted at a SHA-256 conversation directory; temp/cache/outbox paths are VM-local |
| Published file continuity | Immutable S3 objects plus a catalog reference on conversation metadata |
| History and progress index | Append-only event items with bounded previews |
| Message/event/checkpoint/result bodies | Content-addressed objects in the encrypted artifact bucket |
| Retention | DynamoDB TTL plus the artifact bucket lifecycle policy |

The conversation table is separate from the run table. The run table's stream drives terminal
delivery, so mixing mailbox events into it would couple conversation coordination to result egress.

## Item and object layout

The physical DynamoDB key does not expose a provider conversation ID:

```text
pk = CONVERSATION#sha256(conversationId)

META
MAILBOX#sha256(messageId)
TURN#sha256(turnId)
EVENT#occurredAt#sha256(eventId)
REACTION#sha256(messageId)#sha256(emoji)#sha256(ownerId)
```

Pending message items project these attributes into `conversation-work-index`:

```text
workPartition = CONVERSATION#sha256(conversationId)
workOrder     = 0|1#createdAt#sha256(messageId)
```

`0` means `interrupt`; `1` means `defer`. Consuming a message removes both index attributes in the
same transaction that decrements `pendingCount` and appends the consumption event.

S3 objects use owner- and conversation-hashed prefixes:

```text
owners/<owner-hash>/conversations/<conversation-hash>/messages/<message-hash>-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/events/<event-hash>-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/turns/<turn-hash>/slice-0000-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/artifacts/<time>-<turn-hash>-<content-hash>.json
owners/<owner-hash>/conversations/<conversation-hash>/attachment-manifests/<message-hash>-<digest>.json
owners/<owner-hash>/blobs/sha256/<content-hash>
runtime/conversations/<conversation-hash>/codex-home/...
runtime/conversations/<conversation-hash>/workspace/...
```

The hash in each object name makes identical retries converge on the same object. A conflicting
reuse of a message ID is rejected by DynamoDB even when the provider retries concurrently.
Catalogs preserve each file's relative name, media type, source run, and digest separately from the
owner-scoped content-addressed blob key. Upload manifests remain conversation-private, while their
bytes use the same runner-admitted `owners/<owner-hash>/blobs/sha256/...` envelope as other durable
artifacts. Existing catalogs with legacy `runs/<run-id>/artifacts/...` keys remain readable during
migration.

## Owner read model and local console

`GET /v1/conversations?visibility=visible|hidden|all` lists newest-first owner summaries. Each entry
uses an opaque SHA-256 conversation ID rather than the provider or internal routing ID and includes a
stable bounded title, newest safe message preview, and durable `pinned`, `hidden`, and `unread`
state. `POST /v1/conversations/{opaqueId}/organization` changes those owner-scoped markers. Hiding a
conversation only changes its inbox visibility: it does not stop a running turn, discard its files,
or suspend a routine. `GET /v1/conversations/{opaqueId}?limit=50&nextToken=...`
returns safe lifecycle state and one cursor-paged durable transcript window in chronological reading
order. The user and assistant entries are indexed transactionally with their accepted/completed
conversation state, while immutable bodies remain in S3. Attachments cross the public projection as
opaque 24-hex content IDs, never bucket/key coordinates. Reply edges use stable public transcript
message IDs. Owner reactions (`👍`, `❤️`, `🎉`, and `👀`) are durable annotations and never create a
Run or change execution authority. These projections omit owner/capability principals,
object-store references, MicroVM IDs, Codex thread IDs, and policy bindings. An API-created
conversation also returns its caller-chosen `threadKey`; provider-created conversations do not
expose a reply target through the API.

`GET /v1/conversations/search?q=...` searches the authenticated owner's indexed user messages,
assistant messages, and artifact paths, including conversations outside the currently loaded list and
hidden conversations. Results contain bounded snippets and opaque artifact IDs, never S3 coordinates
or execution handles. Search postings share the conversation retention deadline and are written in
the same DynamoDB transaction as the transcript or completed turn. Search is forward-indexed: data
created before a deployment gains this feature needs a one-time reindex before it is discoverable by
message or filename.

The desktop testing console uses only those public routes plus existing Run events and controls. It
keeps AWS credentials in a loopback signer instead of browser storage:

```bash
RAT_THINGS_API_URL=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com \
AWS_PROFILE=YOUR_PROFILE \
AWS_REGION=YOUR_REGION \
npm run console:serve
```

Open `http://127.0.0.1:4174`. The console can create/continue API threads, attach up to six files
(4 MiB each and 6 MiB total), page older transcript
windows, search messages and files across the owner's durable history, pin and hide conversations,
persist read state, reply to a specific transcript message, add/remove durable reactions, preview
private text, image, audio, video, and PDF artifacts, poll typed live activity, answer structured
ordinary input requests, and interrupt an active turn. It does not replace the CLI or change
execution: submitted work still follows the normal
control API, durable Run, coordinator, and Lambda MicroVM path. Public activity cards deliberately omit raw App
Server methods/parameters, commands, results, reasoning, and native thread/turn IDs. While a turn is
active, the console reports the durable lifecycle as
`Queued`, `Starting`, `Working`, or `Stopping` and shows elapsed time. `Starting` deliberately covers
both allocation or resumption of an owner-bound MicroVM and preparation of its durable workspace;
it warns that first-use storage can take tens of seconds rather than presenting an indeterminate
frozen state.

When an App Server request bridge is present, the runner enables Codex's Default-mode structured
input feature for that thread. The resulting question is an ordinary interaction inside the Run's
precomputed capability envelope: answering it does not approve or widen IAM, integration, network,
filesystem, or browser authority. Runs without a request bridge do not expose the tool.

The deterministic browser E2E starts a fake owner-scoped control API and the real loopback console
proxy, then drives conversation creation, upload validation and transport, structured question
response, unloaded-history search, transcript/file navigation and inline viewing, reply/reaction
controls, pin/hide/read persistence, pagination, per-conversation drafts, autonomous live activity,
durable completion, and question/drawer layouts at 390 pixels in Chromium. Failure artifacts include a screenshot,
trace, and video:

```bash
npm run test:e2e:console:install # once per machine
npm run test:e2e:console
```

Playwright artifacts can contain prompts, transcripts, and activity details. The test configuration
creates them with private local permissions, `test-results/` is ignored, and test prompts should
still use disposable data. Remove retained artifacts securely when they are no longer needed.

To retain a successful run as a broadly playable H.264 MP4 (requires `ffmpeg`):

```bash
npm run demo:console
# test-results/rat-things-console-demo.mp4
```

The live AWS browser leg uses the same UI and signed proxy against the disposable deployment. It
submits two turns to one owner-scoped API conversation, waits for the real Lambda MicroVM after
each submission, and checks the four-message durable
transcript through the public read model. It also proves both turns used the same private MicroVM
identity without exposing that identity through the browser-visible Run projection:

```bash
./scripts/aws-e2e-deploy.sh browser-demo
./scripts/aws-e2e-console-test.sh browser-demo
./scripts/aws-e2e-destroy.sh browser-demo
```

To record that focused live journey as a broadly playable H.264 MP4 (requires `ffmpeg`), run the
demo command between deploy and destroy. It adds short human-readable pauses but preserves every
functional assertion:

```bash
./scripts/aws-e2e-deploy.sh browser-demo
npm run aws:e2e:console:demo -- browser-demo
./scripts/aws-e2e-destroy.sh browser-demo
# test-results/rat-things-console-live-demo.mp4
```

To test an already-running stack without taking ownership of its lifecycle, do not run deploy or
destroy. Resolve the exact current deployment, restore the same AWS profile/credential context used
to deploy it, and run only the focused test:

```bash
cat .aws-e2e/latest
rat_deployment_id="$(<.aws-e2e/latest)"
AWS_PROFILE=YOUR_PROFILE ./scripts/aws-e2e-console-test.sh "$rat_deployment_id"
```

The focused test creates a uniquely named durable conversation and two Runs and can leave a suspended
MicroVM until normal lifecycle cleanup or stack teardown. Its preflight rejects an AWS account or
principal that differs from the deployment record. Teardown clears `.aws-e2e/latest` when it still
points at the destroyed deployment; an absent pointer means the operator must choose an explicit
live deployment ID. `npm run aws:e2e:status` lists local deployment records as `ready-local`,
`partial-local`, or `destroyed`; this is a read-only local inventory, not proof that every AWS
resource still exists.

The full `npm run test:e2e:aws` lifecycle now runs both the existing AWS workflow suite and this
browser journey before its exit trap destroys and audits the ephemeral stack.
requires the one-time Chromium installation above. Never leave a manually deployed test stack
running after the test; if the browser leg fails, run the printed destroy command.

For an isolated unsigned local control plane, set `AGENT_RUNTIME_UNSIGNED=true` and
`RAT_THINGS_LOCAL_OWNER=<test-owner>` on the console process while the backend separately opts into
`ALLOW_OWNER_HEADER=true`. Never use that owner-header escape hatch in a deployed stack, and do not
expose the console server beyond loopback.

The owner index is populated whenever a conversation is created or receives another message.
Conversation metadata written before this index existed needs one new message or a one-time
throttled backfill before it appears in the list.

## Turn lifecycle behind the Run

```text
authenticated activity -> reserve Run -> optional mailbox append -> SQS wake
       public receipt <------ same Run ID -------------------------+
                                                                  |
                                                                  v
                                      acquire lease -> attach replay -> dispatch Run
                                                    |
                                      +-------------+-------------+
                                      |                           |
                                      v                           v
                               complete/fail             checkpoint/resume
                                      |
                                      v
                         suspend VM + save replay context
```

The transaction boundaries cover coordination records, not S3. Bodies are written to S3 first,
then their references are committed in DynamoDB. A failed DynamoDB transaction can therefore leave
an unreachable content-addressed object, which the bucket lifecycle policy eventually removes. A
DynamoDB record never points at an object that the service has not finished writing.

## Validation

`npm run test:e2e:localstack` provisions the real table, bucket, and queues and validates:

- idempotent append and conflicting message-ID rejection;
- interrupt-before-defer ordering through the DynamoDB GSI;
- lease acquisition and stale-token rejection;
- turn start, progress, message consumption, and event history;
- S3-backed checkpointing, lease release, reacquisition, and slice resume; and
- signed Teams ingress through mailbox, coordinator, run, completion, and threaded egress;
- terminal completion with all pending work consumed; and
- a second Teams activity selecting the prior MicroVM/Codex session and replaying prior context.

LocalStack validates the AWS control protocol and session-selection behavior but cannot implement
the Lambda MicroVM or S3 Files APIs. The disposable live-AWS suite validates same-VM suspend/resume,
session-expiry replacement, crash-window recovery, and a real Codex app-server turn that writes a
file with a tool call. It then terminates that VM, observes the file in the backing S3 bucket, mounts
the state in a replacement VM, resumes the exact Codex thread ID, and reads the exact bytes without
recreating them. It does not yet measure sustained concurrency/cost or validate Microsoft identity
and delivery into a real Teams tenant.

## Current boundaries

Mailbox `interrupt` priority applies to queued thread work; the separate active-Run control route
can interrupt a currently running Codex turn. Typed live activity and ordinary input requests are
pollable but bounded and ephemeral, while terminal JSONL is durable. Structured questions project
only bounded labels/options and return the App Server's ordinary answer shape; they do not add an
approval gate. Rat Things deliberately has no
human-approval inbox; it also does not yet offer browser takeover, Rat-authored long-history fallback
summaries, cross-conversation semantic memory, or sustained-concurrency guarantees. Native Codex
thread compaction is preserved under the conversation's S3-backed `CODEX_HOME` and has been verified
across a fresh App Server process. Bounded replacement-VM replay remains a complementary fallback:
it carries cumulative omission counts and an explicit handoff notice, but does not claim to summarize
omitted content. Those are deliberate boundaries of the current engineering preview, not alternate
execution models.

The conversation's execution and integration policy is fixed by its first accepted Run. Later turns
must match it; they cannot widen authority through a message or response. See [the capability
envelope](capability-envelope.md).
