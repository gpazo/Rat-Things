# Rat Things and Grok Bot: current product and implementation comparison

Date: 2026-08-26 UTC (August 25 PDT)

## Scope and evidence

This comparison uses three distinct evidence sets:

- Grok Bot's current public documentation, last updated August 11, 2026, including
  [overview](https://docs.x.ai/grok-bot/overview),
  [Bots and memory](https://docs.x.ai/grok-bot/bots),
  [chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration),
  [files and results](https://docs.x.ai/grok-bot/files-and-results),
  [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), and
  [security boundaries](https://docs.x.ai/grok-bot/approvals-security-and-privacy);
- the unofficial local Grok Bot 0.18 reconstruction at commit `a9f633e`, whose provenance pins the
  public 0.18.0 application but does not imply an upstream source-code license; and
- the current Rat Things working tree and its tests.

The current Grok product is newer than the 0.18 dump. Documentation is evidence for today's
product behavior; the dump is implementation evidence only for behavior present in that pinned
release. Rat should port useful invariants independently and must not copy reconstructed UI assets,
implementation text, private RPC contracts, or generated protocols.

## Executive result

Rat now has a credible backend counterpart for durable autonomous work: owner-scoped APIs,
conversation-isolated Lambda MicroVMs, S3 Files state, durable Runs, continuation, schedules,
provider ingress and delivery, brokered integrations, browser use, files, publications, and
generation-fenced recovery. Its isolation and authority model is intentionally different and, for
separate customer jobs, narrower than Grok's user-wide shared-computer boundary.

The largest remaining product gap is **semantic memory**, followed by the named-Bot/group product
model, hosted connector authorization, general desktop control, and rich chat/artifact UX.
Native Codex compaction is durable in Rat; semantic memory is not currently enabled or correctly
scoped. Those are separate features and must not be reported as one.

The conversation priority selected for this port is now implemented and live AWS validated: stable
titles and previews, cursor-paged durable transcript entries, encrypted composer uploads, targeted
replies, owner reactions, structured ordinary input, private inline artifact viewers, typed activity
cards, durable pin/hide/read organization, owner-scoped message/file search, transcript/artifact
navigation, and responsive desktop/mobile testing controls. Raw App Server methods, parameters,
commands, results, native thread IDs, authority principals, and storage coordinates do not cross the
live public projection.

## Side-by-side capability matrix

Status means parity with the useful product behavior, not similarity of deployment architecture.

| Capability | Current Grok Bot docs and 0.18 code evidence | Rat Things after this port | Status |
| --- | --- | --- | --- |
| Product unit | Persistent named Bot with profile, role, conversation, routines, memory, avatar, pin/hide/duplicate lifecycle; up to 50 Bots and groups | Durable Conversation is the continuity unit; a Thing is the reusable immutable task unit; no named-agent roster | Partial; deliberate noun/model divergence |
| Client surfaces | macOS, Windows, and iOS with synchronized Bots and conversations | Authenticated OpenAPI, provider webhooks, a loopback testing console, and a conversation-capable CLI with discovery, paging, attachments, replies, reactions, organization, readable activity, structured answers, and typed browser control; no mobile client | Partial; CLI coverage is now broad, native client breadth remains smaller |
| Embedding/API | Product primarily presents desktop/mobile UI over private desktop/coordinator contracts | Self-describing IAM-authenticated API, discovery document, JSON Schemas, CLI, and embeddable control plane | Rat advantage |
| Execution isolation | One managed Linux computer per user; all that user's Bots share files, browser logins, and command-line credentials, with separate screens | One Lambda MicroVM per active conversation/session; owner and conversation state are fenced; permissions are intersected before launch | Equivalent autonomy; Rat has a narrower per-conversation boundary |
| Background work | Bots and routines keep working with the client closed | SQS/EventBridge/Lambda MicroVM orchestration is independent of the CLI or console | Parity |
| Conversation continuation | Persistent Bot conversation and working context across devices | Durable mailbox/checkpoint plus native Codex `thread/resume`; same-VM and replacement-VM continuation are live validated | Core parity |
| Native context compaction | 0.18 has provider-aware self-summary/compaction, summary archives, recent-tail preservation, durable prompt blocks, and a searchable full transcript location | Codex App Server compaction persists inside the S3-backed conversation `CODEX_HOME`; Rat also records truthful bounded-replay omission counts | Partial: native compaction works; Rat-specific fallback summaries do not |
| Semantic long-term memory | Current docs promise stable preferences, role context, facts, and prior-work summaries. The dump has agent/user/project memory shards, extraction, episode summaries, relevance/decay, synthesis, explicit-memory protection, and prompt injection | Codex's optional memory feature is disabled; Rat has no cross-conversation owner/Thing memory contract | Missing and highest-priority gap |
| Durable workspace | Server-synced shared computer files are recoverable independently from conversation history | S3 Files preserves workspace and Codex state; replacement MicroVM restore and exact file/thread continuation are live validated | Parity with different scope |
| Conversation list | Named Bot/group sidebar, sections, attention/unread state, pin/hide, search | Owner-scoped Pinned/Needs attention/Recent sections, hidden view, durable pin/hide/read state, newest-first paging, opaque IDs, stable bounded titles/previews, progress/session health, and server search across unloaded messages/files; console and CLI use the same routes | Core list and organization parity; named Bot/group roster remains separate |
| Transcript history | Rich long-lived transcript with messages, tool/computer activity, files, questions, approvals, replies, reactions, search, and thread affordances | Cursor-paged durable user/assistant transcript windows with compaction count, safe attachment IDs, targeted replies, owner reactions, structured questions, legacy checkpoint fallback, search-result navigation/highlighting, and matching CLI commands | Core parity except approvals by design and richer collaboration/thread affordances |
| Live activity | Human-readable tool/computer cards and attention states | Typed safe cards for agent, message, reasoning, command, file, tool, web, computer, plan, compaction, usage, and errors; CLI watch is readable by default with JSON snapshot and JSONL diagnostic modes | Core parity for observation; fewer rich cards |
| In-progress control | Follow-up messages redirect work; stop; questions and approvals | `steer`, `interrupt`, queued `interrupt`/`defer`, and ordinary structured input responses through API, console, and structured CLI answer commands | Parity except approvals by design |
| Approvals | Per-action approvals, Auto Review rules, secure computer handoff, and local-computer command policy | No mid-Run permission inbox. IAM, network policy, grants, and the capability profile fix the maximum envelope before launch | Intentional divergence |
| Attachments | Desktop accepts common document/media/code formats, six at a time, with documented size limits; cards and viewers are built in | Responsive composer and repeatable CLI option accept six bounded files; encrypted content-addressed bytes restore before execution; the public transcript emits only opaque IDs; private text/image/audio/video/PDF viewers use an owner-signed loopback proxy | Core parity for tested formats; fewer rich document/link previews |
| Files and results | Conversation cards preview generated files, links, images, and tool results; shared `/workspace` supports Bot handoff | Checksummed durable outbox, catalogs, private inline viewers, owner-checked URLs/downloads, conversation restoration, and signed publications | Backend parity or stronger; fewer rich result cards and no Bot handoff UI |
| Browser/computer use | Browser, filesystem, terminal, full desktop computer use, human takeover for passwords/2FA/CAPTCHA, and per-Bot screens | Active browser-enabled Runs now have an owner-scoped live 1280×720 viewer, a renewable exclusive human browser lease, console controls, and typed CLI commands for navigate/click/type/press/select/scroll/wait/back plus screenshots and video; no general desktop/native-app control | Close browser parity; narrower intentional desktop scope |
| Teach by demonstration | Records a browser workflow for up to ten minutes and creates a draft skill | Records up to ten minutes/100 allowlisted browser actions, redacts typed/selected values and URL query/fragment data, and creates an unpublished manual Thing draft for review; the complete path is live AWS validated | Core lifecycle parity; different reusable unit |
| Skills | Reusable instructions, private/marketplace skills, per-Bot enablement, `/` mentions | Codex skills can be selected and resolved through App Server; Thing definitions provide a separate immutable reusable-work contract | Partial; no hosted catalog or skill-management UI |
| Routines/automations | Per-Bot schedules and supported event triggers, up to 50 routines and 20 recent records; test/edit/pause/run/delete UI | Durable interval Routines plus revisioned Things with manual, EventBridge rate/cron, and signed event ingress; the console now creates, lists, pauses, resumes, runs, and deletes interval Routines | Close core lifecycle parity; editing/history and richer event UX remain |
| Plugins/connectors | Marketplace, account-owned OAuth connections, MCP, per-tool enablement, team restrictions, in-chat Connect cards | Trusted provider manifests, self-hosted OAuth-code/PKCE installation and independently rotating token families, owner-scoped multi-account Connections UI, brokered secrets, grants/resource constraints, live-validated Slack search/post/thread/reaction tools, Stripe/fixture adapters, and Codex MCP/app selection | Core install/security UX substantially closed; marketplace breadth intentionally deferred |
| Credentials | Hosted connector tokens stay in the backend; browser logins live on the shared user computer; secure secret requests exclude values from transcript/model | Secrets Manager plus a host-only credential broker; values never enter Runs, DynamoDB, logs, task overrides, repository URLs, or model-visible tool metadata | Rat advantage for implemented integrations |
| Multi-agent collaboration | Two to six Bots per group, direct messages, mentions, visible handoffs, shared files, parallel screens | No public durable Bot/group/handoff model. Any model-internal sub-agent behavior is not a Rat product contract | Missing |
| Provider channels | Synchronized desktop/iOS experience; current docs focus on Bot/group chat and connectors | Signed GitHub, GitLab, Teams, and Slack ingress; real Slack app-mention/source-thread continuation live validated; IAM API clients | Rat advantage for backend ingress/egress breadth |
| Publications/sharing | Result/file cards can be opened and saved; current docs emphasize reviewable artifacts | Manifest-last file/site/video publications, isolated hosts, short-lived grants, CloudFront OAC, and CLI/API redemption | Rat advantage |
| Supervision/recovery | 0.18 coordinator has generation/process identity, heartbeat, quarantine, miss thresholds, bounded respawn, blob recovery, and repair paths | Immutable execution generations, conditional heartbeats, exact MicroVM inspection, quarantine, stale failure/cancellation, queues, alarms, and live fault injection | Parity at state-machine level |
| Interrupted tool settlement | 0.18 reconstructs interrupted pending tool state and avoids malformed continuation | Live requests are ephemeral; consequential dynamic calls have bounded durable evidence, but unmatched interrupted tool calls are not fully settled into replacement context | Partial |
| Large tool output | 0.18 spills oversized MCP/tool output to agent-readable files with inline location metadata | Integration JSON currently fails above 128 KiB | Missing usability feature; safe current failure |
| Concurrency | Several Bots can reason and use connectors in parallel; each gets a screen on the shared computer | Different conversations can occupy separate MicroVMs; one fenced turn owns each conversation workspace | Architectural parity; sustained-load proof missing |
| Security maturity | Published user/team controls, shared-computer warnings, approvals, admin policy, and hosted service boundary | Strong internal invariants and disposable AWS proofs, but still an engineering preview without completed penetration test, budgets/rate limits, or multi-tenant review | Grok product is operationally ahead |

## Memory and compaction validation

The validation result is intentionally narrow and reproducible:

| Question | Evidence | Result |
| --- | --- | --- |
| Does Rat persist native Codex state? | Runner maps `CODEX_HOME` to the conversation S3 Files state root and excludes only temporary/cache/plugin staging paths | Yes |
| Can a fresh App Server process resume the same native thread? | Live local App Server regression starts a thread, stops the process, and resumes the exact thread from the same persisted `CODEX_HOME` | Yes |
| Does automatic native compaction survive that process boundary? | The regression forces the compaction threshold, checks a pre-compaction marker after resume, and observes a `contextCompaction` item | Yes |
| Is Codex semantic memory enabled? | Packaged Codex 0.146.0 reports `memories` stable but disabled; Rat's `config/codex.toml` does not enable it | No |
| Would simply enabling it give Grok-style Bot memory? | Rat launches a fresh App Server process for each turn; Codex memory maintenance starts asynchronously, uses Codex-home/project state, and Rat assigns a separate `CODEX_HOME` to each conversation | No |
| Does Rat have a cross-conversation semantic-memory contract? | No owner-, Thing-, or named-agent-scoped memory store, extraction lifecycle, provenance, correction, deletion, or injection policy exists | No |

Therefore Rat may claim **durable native conversation compaction and thread continuation**. It may
not claim Grok-style semantic memory yet. The existing bounded replacement replay is also not a
semantic summary: it tells the agent that content was omitted and where durable state can be
inspected.

## Port completed in this pass: durable conversation experience and typed activity

The port is Rat-native rather than a renderer transplant:

- conversation metadata conditionally stores a first-message title and updates the newest safe
  message preview without reading S3 during list rendering;
- each accepted user message and completed assistant result writes an immutable transcript index
  item in the same DynamoDB transaction as its mailbox/turn event;
- `GET /v1/conversations/{opaqueId}?limit=...&nextToken=...` returns stable newest-page cursors and
  each page in chronological reading order;
- transcript hydration reads immutable S3 bodies, caps public text, and converts attachments to
  opaque SHA-256 IDs instead of exposing bucket/key coordinates;
- legacy conversations without transcript index entries still render their current checkpoint;
- the live Run endpoint maps App Server traffic to a typed product projection and removes raw
  protocol methods, params, request params, commands, outputs, and native thread/turn IDs;
- the console renders title/preview metadata, typed activity, and a `Load earlier messages` control;
- the owner-scoped organization contract persists pin, hide, and manual read/unread state without
  changing message recency, and the console exposes Pinned, Needs attention, Recent, and Hidden
  views;
- accepted user messages, completed assistant messages, and artifact paths create bounded encrypted
  search postings transactionally, while results remain owner-filtered and expose no S3 or native
  execution coordinates;
- all-history search can open an unloaded conversation and jump to the matching transcript message
  or artifact card;
- the responsive composer uploads bounded files into owner-scoped content-addressed storage and the
  runner restores them under `.rat-things/artifacts/uploads/` before the agent begins;
- stable transcript message IDs support targeted replies, and owner-scoped reaction transactions
  support `👍`, `❤️`, `🎉`, and `👀` without creating a Run or changing authority;
- bounded structured questions are answered as ordinary App Server input, never approvals, and the
  runner enables the Default-mode question feature only when its request bridge is present;
- the loopback signer previews private text, image, audio, video, and PDF content through a bounded
  same-origin share and exact regional-S3 redirect chain without forwarding API signing headers;
- desktop and 390-pixel mobile controls cover the composer, transcript, activity, question form,
  artifact viewer, search, organization, and continuation flows; and
- the CLI now covers list/search/show pagination, source collection, pin/hide/read state, reactions,
  bounded local attachment preparation, targeted replies, interrupt/defer delivery, readable
  activity, structured question answers, and every allowlisted human browser action without adding
  a second backend or exposing private MicroVM/native-thread identities; and
- OpenAPI, developer docs, focused unit tests, the browser E2E, architecture checks, packaging,
  documentation build, and Terraform validation cover the new contract.

Historical conversations require a throttled one-time transcript-index backfill if a deployment
must page beyond its existing checkpoint. New activity lazily repairs title/preview metadata, but
it cannot reconstruct every older transcript page without reading historical event bodies. Search
is also forward-indexed: pre-port messages and artifact catalogs require a one-time search-posting
backfill before they can appear in all-history results.

## Validation record

- Fresh live AWS `clifix260827b`: the strict CLI and opaque-public-ID artifact changes passed the
  26.6-second two-turn CLI scenario on a clean 234-resource S3 Files stack. List/search, complete
  source collection, attachment retrieval, organization, reaction, targeted reply, delivery policy,
  and same-MicroVM continuation were exercised through independent CLI processes; a deliberately
  unknown mutation option failed before the request. All 12 enabled live scenarios passed across
  the complete run and focused real-Codex replacement retries, the optional publication-domain
  scenario was skipped, and all 234 resources were destroyed afterward.
- Fresh live AWS `cli260826b`: all 12 enabled workflow scenarios passed in 662.74 seconds on a
  clean 234-resource stack with S3 Files and Lambda MicroVMs enabled; only the optional
  custom-domain publication scenario was skipped. The expanded CLI scenario covered discovery,
  transcript/source inspection, bounded attachment upload, organization, reaction, targeted reply,
  and interrupt/defer delivery over two turns on one suspended MicroVM. The typed computer scenario
  covered status/watch, takeover, teaching, navigate/type, and release. The stack was destroyed and
  its tagged-resource audit passed.
- Real-Codex CLI review `cli260826a`: a cold attached-file turn completed in about 19.9 seconds and
  a targeted follow-up resumed the same suspended MicroVM in about 5.8 seconds end to end. The
  public client showed the attachment, answer, durable reaction, reply relationship, and organized
  conversation without exposing the native Codex thread or MicroVM identity. Its 234 resources
  were destroyed afterward.
- Real local Codex 0.146.0: forced compaction survived App Server termination and exact-thread
  resume from the same durable `CODEX_HOME`; both the pre-compaction marker and
  `contextCompaction` were observed.
- Deterministic Chromium E2E: stable title/preview, typed activity with no raw App Server method
  names, durable completion, older-transcript pagination, unloaded message/file search, artifact
  navigation, pin/read/hide persistence, stale-search fencing, draft preservation, and mobile layout
  passed.
- Live AWS `cv260825a`: a real Codex-driven two-turn IAM-authenticated browser journey passed in
  46.8 seconds against deployed DynamoDB, encrypted S3, S3 Files, API Gateway, and a Lambda
  MicroVM. The second prompt omitted the first marker and the agent recalled it exactly; both Runs
  retained the same private MicroVM execution ID and native Codex thread ID. The journey also
  exercised durable pin/read/hide state, server message/file search, transcript/artifact jumps, and
  signed public projections. All 228 resources were destroyed afterward; the tagged-resource audit
  confirmed the remaining AWS tombstones gone, terminal, or deleting.
- Full repository gate: 75 files and 320 enabled tests passed, all 13 Lambda bundles packaged and
  smoke-loaded, the 26-page documentation site built, and all Terraform configurations validated.
- Fresh live AWS `rm260825a`: the two-turn IAM-authenticated console journey passed in 51.3 seconds
  against deployed DynamoDB/S3/S3 Files/API Gateway/Lambda MicroVM resources; it produced four
  ordered transcript entries and retained the same private MicroVM identity. The deployment used
  the deterministic mock runner, so it did not validate real-model activity projection or semantic
  memory. All 226 resources were destroyed and the post-teardown tag audit passed.
- Fresh live AWS conversation-parity rerun: a real Codex-on-Bedrock agent restored an uploaded file,
  paused for and consumed a structured mobile answer, generated and rendered a private artifact,
  retained a reaction across reload, and completed a targeted-reply second turn in the same private
  MicroVM and native thread. It recalled an unstated continuity marker exactly. The public four-entry
  transcript exposed no owner, storage, MicroVM, or native Codex coordinates, and all inspected
  completion/failure/dead-letter queues were empty after success.
- LocalStack execution was unavailable because Docker Desktop's daemon was unresponsive; its
  Terraform configuration still validated. This does not replace or weaken the fresh AWS proof,
  but it remains an environment-specific missed test leg.

## Recommended next priorities

1. **Rat-native semantic memory.** Define explicit owner, Thing, and conversation scopes; immutable
   evidence; generated versus explicit origins; correction/tombstone semantics; bounded recall;
   model/version provenance; and conditional synthesis commits. Run maintenance outside the
   per-turn App Server lifetime. Continue to let Codex own native context compaction.
2. **Expand reviewed connector breadth without a marketplace.** Use the new self-hosted OAuth and
   connection-management contract to add high-value adapters one by one with provider fixtures,
   scope-denial tests, and live disposable accounts.
3. **Complete Things and routine history/editing UX.** Connection and Routine lifecycle pages now
   expose the existing backend; Things, immutable revision review, last-run evidence, and safe
   editing remain.
4. **Extend the live-validated browser takeover and teaching path.** The Rat-native implementation
   transfers interaction inside the existing envelope and saves an unpublished Thing draft. Add
   secure host-side credential injection, file transfer, richer pointer/tab workflows, and
   replacement-session browser-profile validation without turning takeover into authority
   escalation.
5. **Interrupted tool settlement and large-result spill.** Close exact pending calls without
   replaying writes, then add bounded/redacted spill files under the conversation artifact policy.
6. **Named Bots and groups only after a product decision.** This changes ownership, memory scope,
   routing, concurrency, and UX; it is not a frontend-only port.
7. **Optional conversation extensions.** Multi-owner collaboration, branch/fork or
   edit/regenerate semantics, richer office/link previews, presence, and notifications remain
   product decisions rather than unfinished hidden primitives.

## Explicit non-ports

- Do not replace conversation-scoped MicroVM isolation with Grok's shared user computer merely to
  match the product vocabulary.
- Do not add Grok's approval inbox to Rat's fixed-envelope execution model.
- Do not replace Secrets Manager and the credential broker with Electron or box-local secrets.
- Do not import the reconstructed renderer, Electron bridge, generated protobufs, daemon PID
  protocol, or private account/session contracts.
- Do not represent native Codex compaction, S3 durability, or a bounded replay counter as semantic
  memory.
