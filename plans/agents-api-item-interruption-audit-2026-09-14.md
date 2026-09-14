# Item finalization on interruption and execution loss

This local follow-up addresses unfinished Item status after the
[message/output work](agents-api-message-output-audit-2026-09-14.md). It does not
change AWS, Terraform resources, the native binary or the deployment running the
long soak. No heartbeat is resumed.

## Finding and correction

The official [Item reference](https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/subresources/items/methods/list)
and pinned SDK support `incomplete` for output and function-call Items. The pinned
native source (`0.154.0`, commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`) sends
Turn interruption without a final agent message in
`codex-rs/app-server/src/bespoke_event_handling.rs:1613`. The local native fixture
confirmed that a partial message was left `in_progress` even after its public
Turn became `cancelled`.

The runtime now calculates an incomplete status for Items still marked
`in_progress` when their Turn fails or is cancelled, their thread closes, or the
harness stops. It preserves partial text, command output, reasoning summaries,
IDs and phase. Previously completed/failed/incomplete Items and unknown nullable
statuses retain their existing values. Missing completion is not treated as
evidence that a tool failed, and no function result is invented.

Root-only failure/closure affects root Items; child work stays independent.
Harness loss finalizes unfinished Items in all active Turns. Retryable native
errors leave Items active. Existing stream planning emits the resulting Item
completion events before the terminal Turn event.

Late message, reasoning and command append deltas no longer alter an Item that
has reached a final status. A repeated reasoning-part addition also cannot reopen
that Item. Authoritative native Item-completion payloads remain a separate path;
this pass does not claim to resolve every out-of-order completion or recovery
race.

The functional-programming guidance is reflected in a shared pure calculation
over Item values and explicit checks at the projection boundary. There are no
new storage operations, tool effects, timers or mutable caller-owned inputs.

## Verification

- Five initial unit regressions failed before the finalization change; a retained
  retry/confirmed-failure case already passed. Three additional late-delta
  regressions failed before the projection guards. All nine now pass.
- The native fixture streams a completed reasoning Item and an unfinished
  commentary message, then performs real native cancellation. Its partial-message
  assertion failed beforehand and now passes. The complete-stream variant also
  passes. Both validate public event schemas and Item-before-Turn ordering.
- The combined strict run passes 57 tests: interruption (9), native Item events
  (2), native Session/delegation (25), runtime (15) and journal (6), using
  `CODEX_REQUIRE_PARITY=true` and the patched native binary. Evidence:
  `.aws-e2e/ag260913a/item-interruption-targeted.log`.
- Full `npm run check` passes: 939 tests, 14 opt-in skips, architecture and
  generated-contract checks, TypeScript, packaging, site build and all three
  Terraform validations. Evidence: `.aws-e2e/ag260913a/item-interruption-check.log`.
  `git diff --check` passes. Changes remain uncommitted and undeployed at this
  validation point.

## Remaining acceptance

The native interruption proof is local and targets streamed message output.
Deployed interruption during commands, MCP calls and child work remains open,
along with bidirectional/nested native message delivery and recovery after loss
before persistence. Already-terminal historical snapshots are not backfilled.
The [conformance ledger](agents-api-conformance.md) retains the broader contract,
live validation and cleanup work; this pass does not establish full parity.
