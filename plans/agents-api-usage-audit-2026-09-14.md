# Agents API usage projection audit

This bounded audit corrected omitted remote-compaction usage in the native Session
projection. The change is local and has not been deployed to the active AWS soak.
It does not establish complete usage, Item, event, or Agents API parity.

## Contract and source evidence

The official [Turn retrieval reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/turns/methods/retrieve)
and [Session retrieval reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/retrieve)
expose nullable usage with input, output, cached-input, reasoning-output and total
token fields. Their descriptions explicitly characterize usage as best effort and
subject to change. Total tokens represent input plus output tokens. Neither page
by itself specifies all attribution rules for compaction, child work or recovery.

The inspected local Codex source checkout has HEAD
`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`, matching
[`runtime/codex/source.json`](../runtime/codex/source.json), version `0.154.0`.
Relevant files under that checkout's `codex-rs/` directory:

- `core/src/session/turn.rs:2667`: ordinary response completion emits exact
  response usage before recording cumulative token usage.
- `core/src/session/mod.rs:4377`: `record_observed_response_completed` emits
  `RawResponseCompleted`, carrying a response ID and optional observed usage.
- `core/src/compact_remote_v2.rs:449`: remote compaction emits the same exact
  completion event. Its completion path at lines 301–358 records budget usage and
  recomputes context usage without appending compaction to the cumulative model
  token counters.
- `core/src/session/mod.rs:4446`: context recomputation updates the last context
  estimate while preserving cumulative counters.
- `app-server/src/bespoke_event_handling.rs:1199`: the exact event becomes
  `rawResponse/completed` with native thread ID, Turn ID, response ID and usage.
- `app-server/src/request_processors/token_usage_replay.rs:34`: attachment replay
  can emit a historical cumulative usage notification attributed to its old Turn.

The raw event does not label a response as compaction. Both ordinary and
compaction responses are accounted from this one exact feed. Adding exact usage
on top of cumulative usage would count ordinary responses twice.

## Correction

[`session-runtime-planning.ts`](../src/core/session-runtime-planning.ts) now
attributes exact response usage to its native thread and Turn and records the
response ID privately on that Turn. A duplicate response ID on the same Turn does
not add usage. Separate parent and child Turns have independent identity sets.

Once exact usage is available, it replaces the cumulative fallback for that Turn.
Current-Turn cumulative notifications continue updating the thread baseline but
do not add to the exact total. Historical notifications targeting an earlier Turn
are ignored once a later Turn exists, so attachment replay cannot rewind the
thread baseline or duplicate the historical charge. This captures compaction, keeps cached/reasoning details,
and avoids charging both feeds. Missing exact usage preserves the fallback;
explicit zero remains a recorded zero.

Early native notifications can precede the public Turn binding. Binding now
preserves the private response IDs, and journal snapshots retain them across
recovery. Response IDs are not added to public resources or events. The pure
reducer does not introduce model calls, storage operations or credential access.

The existing Session observation path aggregates root and child Turn usage. This
change improves the values supplied to that existing aggregation; it does not
change its attribution policy.

## Verification

Five new regression cases in
[`session-runtime.test.ts`](../tests/agents/session-runtime.test.ts) failed before
the change and passed afterward:

1. Ordinary responses plus compaction, cumulative updates, duplicate exact events,
   and a historical cumulative update after the next root Turn starts.
2. Early public-ID binding and a serialized/restored snapshot preserve exact
   response deduplication without mutating the input state.
3. Root and child work remain isolated, including reused response IDs on separate
   native Turns.
4. Missing exact usage and explicit zero retain different meanings, with the
   cumulative fallback still available.
5. Historical cumulative replay cannot alter earlier usage or overcount a later
   Turn using the cumulative fallback; a real reset on the current Turn still
   starts a new counter interval.

The strict targeted run passed 46 tests: native Session runtime (15), journal (6),
and native Session protocol fixture (25), using `CODEX_REQUIRE_PARITY=true` and the
locally built patched Codex binary. The runtime reducer and test diff have no
whitespace errors. No AWS calls, deployment, Terraform action, package change, or
full repository suite was performed by this audit.

## Remaining acceptance work

- Force remote compaction through the pinned native harness with controlled model
  responses, then compare exact source events to public Turn and Session totals.
  The compaction counterexample here uses the verified native event sequence in a
  reducer/runtime regression rather than triggering remote compaction live.
- Exercise persisted restart/attachment while child work has recorded usage and
  compare root, child and Session resources after replay. Snapshot preservation is
  covered locally; this is not a deployed recovery result.
- Compare AWS provider-reported usage with public resources for compaction and
  concurrent children once deployment changes can resume after the soak.
- Historical snapshots without exact response IDs retain their existing
  cumulative fallback. The change cannot reconstruct omitted historical
  compaction usage or unavailable provider usage. Exact accounting assumes the
  pinned harness delivers its response-completion feed; it is not a substitute
  for durable replay after an unrecorded transport loss.
- Mixed missing/exact feeds need this distinction: the pinned normal-response
  path passes the same optional usage to the exact event and cumulative recorder
  (`core/src/session/turn.rs:2667–2677`). A response with null exact usage does not
  append hidden usage to the cumulative counter either. For a contiguous feed,
  summing known exact responses therefore does not discard a known charge from
  a null-usage response. If the exact event itself was lost, or an older snapshot
  has only cumulative accounting for earlier responses on the same native Turn,
  the first later exact response replaces that ambiguous fallback. It cannot
  infer which previous charges are disjoint. This remains a best-effort recovery
  limit, not a claim of full accounting reconstruction.
- Audit the remaining Item/event variants separately. Passing usage projection
  tests does not close that wider contract review.
