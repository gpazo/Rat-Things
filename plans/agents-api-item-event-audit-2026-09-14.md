# Item and event projection follow-up

This local audit follows the HTTP/artifact and usage corrections. It does not
change AWS, the active soak candidate, Terraform resources or the native binary.
The functional-programming guide informs the implementation: native notifications
are plain inputs to the existing pure reducer, with no new storage or execution
effects.

## Contract and corrections

The official [events and items guide](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
describes saved message content, status and phase, stable event/item addresses,
and completion events as the authoritative complete output. The
[streaming reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream)
and pinned `openai@7.15.0` declarations define reasoning-summary part/text events.
`AgentSessionMessage.phase` explicitly admits `commentary`, `final_answer` or null.

Three concrete corrections are made in `session-run-projection.ts`:

- Text deltas preserve the phase established by the native message instead of
  clearing it. Completion preserves a missing/unknown phase as null instead of
  labeling every unphased message as a final answer.
- Native `item/reasoning/summaryPartAdded` creates the empty public summary part
  immediately. The existing stream planner can therefore emit its added event
  before any text arrives. Repeated additions preserve accumulated text. Empty
  parts survive completion. Private reasoning content remains excluded.
- Negative, fractional and nonfinite summary indexes cannot index an undefined
  array element or loop indefinitely. They are ignored without changing history.
  Valid zero indexes and empty text remain meaningful.

The inspected native protocol is the pinned `0.154.0` checkout, commit
`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. Relevant source coordinates under
`codex-rs/` are `app-server-protocol/schema/typescript/v2/ThreadItem.ts`,
`ReasoningSummaryPartAddedNotification.ts`, `AgentMessageDeltaNotification.ts`
and `app-server-protocol/src/protocol/event_mapping.rs:397`. The phase belongs to
the message Item; text-delta notifications do not carry a replacement phase.

## Evidence

All six focused regressions failed before the corrections and pass afterward:
three message-phase cases, reasoning part/text lifecycle with repeated and empty
parts, and two malformed-index cases. Each transition passes the generated public
Item/event schemas and preserves the input runtime state. The tests also assert
that private reasoning content never appears in public output.

A new fixture runs the patched native Codex binary against a local Responses
server. It verifies actual native notifications for reasoning and commentary,
validates the projected public events, and checks that reasoning, commentary and
final-answer completion precede the terminal Turn event. This fixture passes with
`CODEX_REQUIRE_PARITY=true`; it makes no admitted model or AWS call. Evidence:
`.aws-e2e/ag260913a/native-item-events.log`. The combined pure Item, stream and
journal run passes 15 tests.

Full `npm run check` passes after the combined local changes: 921 tests and 14
opt-in skips, architecture/generated-contract checks, TypeScript, packaging,
site build and all three Terraform validations. It uses the patched native
binary and pinned Linux ARM64 artifact. Evidence:
`.aws-e2e/ag260913a/item-event-followup-check.log`. `git diff --check` passes.
These changes remain uncommitted and undeployed at this validation point.

## Remaining Item implementation and acceptance work

This is a source inventory, not a declaration that each variant is fully verified.

| Public Item family | Current source path | Remaining work |
| --- | --- | --- |
| User/assistant `message` | Session input planner and native Item projector | Broader input-image, interruption, restored-history and provider phase behavior |
| `reasoning` | Native summary Item and part/text projector | Interrupted/incomplete lifecycle and deployed reasoning streams |
| `function_call` | Native dynamic tool Item projector | Namespace, failure and child-tool attribution cases |
| `function_call_output` | Accepted public tool results and subsequent native dynamic-call completion projector | [Message/output follow-up](agents-api-message-output-audit-2026-09-14.md) adds native results and API echo suppression; broader child/failure/provider cases remain |
| `agent_message` | Subsequent owned native inter-agent message projector | [Message/output follow-up](agents-api-message-output-audit-2026-09-14.md) adds typed content and public identity mapping; bidirectional/nested native delivery and deployed recovery remain |
| `mcp_call`, `web_search_call`, `command_execution` | Native Item projector | Full result/error/status variants, cancellation and deployed source correspondence |
| Create/send/resume/wait/interrupt/close subagent calls | Native collaboration projector and v2 coordination planner | Per-operation payload/status comparisons, nested identity resolution and deployed interruption |

The native `ResponseItem::AgentMessage` in `protocol/src/models.rs` carries
author, recipient and input content, whereas the public `agent_message` carries
sender/recipient IDs and public Agent content. The public resource must not be
implemented by simply exposing an arbitrary raw native envelope. The subsequent
message/output follow-up implements that explicit projection and records its
bounded native and replay evidence.

Exhaustive field/default/error comparisons and the remaining live acceptance rows
continue in the [conformance ledger](agents-api-conformance.md). The obsolete-code
and IAM candidates remain in the [caller audit](obsolete-caller-audit-2026-09-14.md).
