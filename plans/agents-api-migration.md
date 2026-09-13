# Agents API migration

Rat Things owns its AWS infrastructure and execution. The target public contract is
OpenAI's Agents API (`OpenAI-Beta: agents=v1`), with the official SDK as the source
of request and response types. Existing public Thing, Run, and conversation
contracts have no compatibility requirement.

Authoritative references:

- https://developers.openai.com/api/docs/guides/agents-api/overview
- https://developers.openai.com/api/docs/guides/agents-api/configuration
- https://developers.openai.com/api/docs/guides/agents-api/sessions
- https://developers.openai.com/api/docs/guides/agents-api/sessions/events
- https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
- https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle
- https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents

## Current implementation

The canonical API and console are implemented on the committed functional
refactor. The public types come from `openai@7.15.0`; the execution protocol is
exercised against `@openai/codex@0.154.0`. All service components remain in the
operator's AWS account. This is not yet a claim of complete hosted-service parity.

The user authorized removing obsolete code when its replacement is ready and
handing dependent removals to a separate agent cycle. The complete dependency
inventory and execution order are in
[`obsolete-implementation-removal.md`](obsolete-implementation-removal.md).

## Acceptance criteria

- [x] Reusable Agents store model, instructions, tools, reasoning, text, and multi-agent settings.
- [x] Sessions own immutable resolved agent configuration, environment, input, and work across turns.
- [x] Inputs to idle sessions start turns; inputs during active work steer that turn.
- [x] Session state is independent of turn outcome; cancellation preserves the session.
- [x] Saved Items and Turns recover work after stream disconnects.
- [x] SSE events use the standard envelopes and do not claim historical replay.
- [x] Environments, environment templates, files, artifacts, and subagents use upstream models.
- [x] Vaults keep secrets write-only and outside agent/session definitions and DynamoDB bodies.
- [x] Resource ownership comes from authenticated identity, with owner-scoped cursors and conditional writes.
- [x] Standard SDK requests exercise installed routes, pagination, errors, deletion, streaming, and retries.
- [ ] Every public contract behavior has a reference, implementation mapping and conformance case; route/type coverage alone is insufficient.
- [x] Standard outbound Session webhooks implement compatible payloads, signatures and durable delivery behavior locally; deployed acceptance remains in the conformance ledger.
- [ ] Idle suspension, subsequent input, environment connection deadlines and execution replacement work under the deployed lifecycle policy.
- [x] Canonical CLI groups, console, signed provider ingress and schedules use the new primitives.
- [x] Legacy public Run/conversation commands and routes are removed; publications select Session artifacts.
- [x] Duplicate private conversation lifecycle and its active infrastructure are removed.
- [ ] Remaining private/local artifact, browser, integration and diagnostic consumers are consolidated.
- [x] The public OpenAPI and deployment routes match; retired contracts are removed.
- [x] Required repository checks pass. MicroVM provisioning is never part of ordinary checks.

## Remaining work before declaring the migration complete

- Track behavior review and the user-authorized post-parity live AWS gate in
  [`agents-api-conformance.md`](agents-api-conformance.md).
- Build an explicit conformance matrix against a pinned upstream documentation and
  SDK baseline. Cover routes, headers, fields, defaults, nullability, validation,
  errors, pagination, resource limits, event payloads/order and lifecycle behavior.
  Mark implemented, unverified and missing behaviors separately. Our endpoint,
  identity and AWS hosting are intentional deployment choices; any remaining
  public behavior difference must stay visible rather than being counted as full
  compatibility. Model identifiers must retain their meaning; do not silently map
  an unsupported requested model or capability to a different one.
- Validate standard outbound Session webhooks in the deployed transport. Provider signature validation and
  Slack/Teams/repository result delivery do not implement this API capability.
  Support `agent.session.created`, `agent.session.action_required`,
  `agent.session.in_progress`, `agent.session.idle` and `agent.session.failed`,
  with owner-scoped subscriptions, signing secrets, durable event delivery and
  the documented retry/signature contract. Verify signed payloads with the stock
  SDK. Preserve the distinction between webhook `action_required` and stream
  `requires_action`; connection requests must be observable before waiting for an
  executor. Endpoint configuration belongs to our AWS control plane.
- The private controller now permits SUSPENDED workers to resume through AWS-issued
  proxy tokens. Self-hosted input uses the five-minute connection deadline, with
  HTTP acknowledgement waiting and late-input rejection covered locally. Validate
  deployed liveness fencing, cancellation/acknowledgement races and replacement.
- Session transitions are journaled atomically with immutable event batches;
  adjacent text deltas may coalesce without dropping lifecycle boundaries. Verify
  remaining event variants, root/subagent attribution, usage after compaction and
  deployed SSE/webhook delivery. Fix the native interruption/follow-up race at the
  child concurrency boundary. Public-item recovery preserves supplied tool facts
  without replay; native checkpoints remain necessary for richer runtime state.
- Provider/schedule input and terminal Turn delivery are migrated. Thing/Routine
  services and public Run/conversation routes, CLI commands, projections and
  submission wrappers are removed. Quickstart creates an Agent and verifies two
  saved Session Turns before deleting its disposable harness. Publications select
  immutable Session artifacts. The private conversation lifecycle and active
  coordinator infrastructure are removed. Continue the handoff for the legacy
  local/private artifact code, explicit retained-data disposition,
  auxiliary scripts and remaining consumer documentation.
- The live API and console smoke canaries now use Sessions, with explicit model
  opt-in. Broader legacy provider, recovery and publication canaries were retired;
  their canonical replacements remain listed in the handoff. They are not covered
  merely because the bounded smoke tests exist.
- Validate the ARM64 images and managed setup on Linux, then run an explicitly
  opted-in AWS deployment check. Local tests exercise the stock harness and
  encrypted executor protocol, but cannot establish AWS provisioning, IAM,
  direct API streaming, relay transport or runtime recovery behavior by themselves.
- Exercise actual model calls for the deployment's admitted models, programmatic
  tool calling, deferred tool search, environment capabilities and MCP servers.
  The native harness tests use a local Responses-protocol fixture, so no external
  model request, model spend or AWS provisioning is part of the ordinary checks.
- Resolve any remaining behavior differences against the upstream guides rather
  than weakening validation or silently ignoring capabilities. Include connection
  deadlines, subagent interruption/resume items, large uploads, artifact limits,
  and sandbox loss in the final deployment conformance review.
- Decide the production lifecycle for managed sandboxes beyond the AWS MicroVM
  execution lifetime. Connected harnesses remain alive between turns; a lost or
  expired managed environment fails explicitly and saved history remains durable.

## Local verification coverage

The conformance suite covers owner isolation, write-only credentials and OAuth
rotation contention, SDK CRUD/pagination, JSON/SSE shapes, binary uploads across
the Lambda request-size boundary, environment templates and skill version
pinning, chunked file writes, immutable artifacts, MCP metadata and network
enforcement, and durable session outbox/journal behavior. Native tests verify
multiple root turns, external function results, child turns and coordination
items, environment-free tool selection, and the encrypted self-hosted executor.

Record the final command outcomes in the change description. Docker-dependent
LocalStack/image tests and AWS tests must be reported separately from local
contract tests; skipped tests are not evidence of deployment compatibility.

## Implementation boundaries

`src/domain/agents-api.ts` imports the public types from the pinned official SDK.
Generated JSON Schemas preserve those types for runtime validation and clients.
Core services own lifecycle transitions against storage and execution ports.
AWS adapters own persistence, credentials, execution, and transport specifics.

The committed functional refactor (`f6b00da`) is part of the working baseline and
is in scope. Baseline `npm run check` passed before this migration.

Literal compatibility includes more than field names: the reference describes
OpenAI-hosted environments and a `codex exec-server --remote` connection for
self-hosted environments. Deployment capabilities and executor protocol support
must be verified before claiming complete compatibility. No endpoint may fabricate
an executable connection URL or silently ignore a requested capability.
