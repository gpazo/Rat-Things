# Inter-agent messages and native function results

This pass implements the two live-history gaps identified by the
[Item/event audit](agents-api-item-event-audit-2026-09-14.md). The changes are local;
they do not alter AWS, the long soak, Terraform resources, credentials or the
pinned native binary. They follow the functional-programming guide by selecting
plain protocol fields in pure calculations and leaving persistence and execution
at their existing boundaries.

## Inter-agent history

The official [subagent Item reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/subagents/subresources/items/methods/list)
includes an `agent_message` resource for messages exchanged between threads. The
pinned SDK defines its sender and recipient as an ID or name and permits both
output text and encrypted Agent content.

The pinned native source (`0.154.0`, commit
`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`) records communication in
`codex-rs/core/src/session/mod.rs:3670`, assigns/persists its Item ID, and emits
`rawResponseItem/completed` via `send_raw_response_items`. The native v2 child
fixture demonstrates the actual delivery: a textual task header and an opaque
encrypted content part, addressed from `/root` to the child's path.

The runtime now admits that specific raw Item type from an owned thread. The
projector preserves its ID and native Turn attribution, maps known root/child
thread paths to public identities, maps input text to public output text and
preserves encrypted content as encrypted content. Unknown names remain names;
they do not acquire execution authority. Native envelope metadata is omitted.
Other raw response types do not become arbitrary public Items.

The recipient's history receives the Item where the harness records it. No
synthetic duplicate is added to the sender's history. Early public Turn binding,
serialized snapshot restore and replay retain one stable Item. Existing stream
planning emits `item.added` with a null output index, as this resource is an
inter-agent message rather than assistant output with a completion status.

## Function result history

The same official reference includes `function_call_output`. The native
`ThreadItem::DynamicToolCall` completion contains `contentItems` and `success`;
the source TypeScript declaration is
`codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts` and its content
union is `DynamicToolCallOutputContentItem.ts`.

Completed dynamic calls now retain a public function result with a deterministic
ID derived from the native call Item, the same call ID and owning Turn, typed
text/image content and explicit success/failure status. Native failure text is
also retained in the error field. Missing output is distinct from an empty array
or empty text. Unsupported native content is not exposed as a misleading partial
result. Arbitrary raw tool outputs are not projected without their corresponding
public dynamic call.

When the application already submitted the result through the API, its accepted
receipt owns the public result ID, original representation and causal position.
`orderedTurnItems` suppresses the native echo by call ID within that Turn before
inserting the accepted receipt. This preserves, for example, an explicitly
submitted empty string instead of replacing it with a native content array.
Different Turns and child histories retain separate attribution.

## Evidence

- The new native child-history assertion failed before the message projector and
  passes afterward. Its expectation preserves the observed native encrypted
  content type; it does not reinterpret that payload as plaintext.
- Programmatic and deferred native function-result assertions both failed before
  the result projector and pass afterward.
- Three focused message tests cover nested ownership, public root identity,
  early binding, restore/replay, empty/encrypted content, exclusion of private
  metadata, typed events and unresolved names (including object-property names).
- Five focused function-result tests cover typed text/image content, empty versus
  missing results, failure text, replay, immutable inputs, Turn attribution and
  unsupported native content. The SDK lifecycle fixture proves an echoed result
  leaves the accepted result and adjacent input in the same order.
- The strict combined run passes 58 tests: native Session (25), native tools (2),
  Session lifecycle (23), message history (3) and function results (5). It uses
  `CODEX_REQUIRE_PARITY=true` and the patched native binary. Evidence:
  `.aws-e2e/ag260913a/message-output-targeted.log`.
- Full `npm run check` passes: 929 tests, 14 opt-in skips, architecture and
  generated-contract checks, TypeScript, packaging, site build and all three
  Terraform validations. Evidence:
  `.aws-e2e/ag260913a/message-output-followup-check.log`. `git diff --check` passes.
  Changes remain uncommitted and undeployed at this validation point.

## Remaining acceptance

The new native proof covers v2 child task delivery and dynamic application
function completions. It does not close every delegation operation or provider
variant. Remaining work includes native/live bidirectional and nested messaging,
interrupted Item status transitions, broader namespace and tool failure cases,
deployed persistence/recovery, and AWS model/tool comparisons. Snapshot replay
cannot reconstruct notifications lost before persistence. Historical records
created before these projectors are not backfilled by this change.

The [conformance ledger](agents-api-conformance.md) continues to track full API
parity, and the [obsolete caller audit](obsolete-caller-audit-2026-09-14.md) retains
the infrastructure cleanup candidates for later deployment acceptance.
