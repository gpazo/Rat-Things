# Agents API migration closeout

The user ended this validation cycle to prevent further scope expansion. The
backend, harness, state and workers remain in our AWS account. Production commit
`a766b7a` is deployed; its CI passed. The branch is
`codex/agents-parity-completion`, PR #1 remains a draft, and these changes are
not merged into main. Full parity is not claimed.

## Accepted this cycle

- Full checks: 1,093 tests passed, 47 opt-in skips; exact ARM64 worker: 405 strict
  native cases passed. The deployed Lambda archive and image pins were verified.
- The earlier file candidate passed 50 inputs, a 50 MiB Files API copy, all
  500 MiB downloaded and hash-verified artifacts, and deletion preserving the
  workspace file. The valid-size base64 stack overflow is fixed.
- The latest candidate passed deliberate hosted setup failure, public Session
  failure, and automatic worker retirement. The reconciler reported one retired
  worker after the grace period. No test-side termination helped this proof pass.
- Latest capacity-1 multi-agent proof passed typed initial tasks, original
  identity preservation, overflow and three interrupted follow-ups. Capacities
  1/6 and provider/MCP proofs also passed on earlier recorded images.
- Original Terraform state retained: lineage
  `be69a19a-2f46-d753-8dc0-0884b98a7269`, serial 598. Template 13, API task 21,
  relay task 18. Immutable pins are in the release JSON.
- All current proof Sessions and Agents were cleaned up. No pending/running
  deployment workers remained at closeout. The soak heartbeat stays paused.

## Explicitly unfinished

1. **Finish the two interrupted test investigations.** The latest capacity-6
   proof passed creation and typed initial tasks, then the model declined a UUID
   target because its native controls use names. The test was stopped at the
   user's wrap-up request; the Session and Agent were deleted and Session 404
   verified. Use the returned child name in the prompt while still asserting
   public recipient IDs, then rerun once. Separately, an exploratory native v1
   close/resume fixture completed its Turn without the expected close Item.
   Diagnose the fixture/tool response before deciding whether code is wrong.
   That unfinished extension was removed; the accepted 405-case suite remains.
2. **Close the existing behavior ledger, without expanding its scope.** Review
   the already listed Item/event variants (including nested identity, images,
   restored history and compaction), and documented defaults, errors and limits.
   Record an implementation/test reference for each row; add work only for a
   concrete documented mismatch. Use `agents-api-conformance.md` and
   `agents-api-item-event-audit-2026-09-14.md` as the fixed input list.
3. **Dispose of remaining cleanup items in a separate cycle.** Use
   `obsolete-implementation-removal.md` and `obsolete-caller-audit-2026-09-14.md`.
   The old public API, coordinator and unused grants are already removed.
   Remaining work is old deployment data/bindings, unused fixtures after coverage
   review, historical media and optional native build-size optimization. Keep
   canonical private Run machinery, active integration consumers and physical
   resource names that still serve the new API. Do not delete retained data
   incidentally.
4. **One final acceptance and merge gate.** After the concrete gaps above are
   resolved, pin one release, run affected checks/live proofs, and mark every
   public behavior row passed or explicitly outside the published contract.
   Then review/merge PR #1. Do not call the migration 100% compatible beforehand.

Detailed evidence and failed attempts remain in
`agents-api-live-storage-2026-09-24.md`; ignored logs stay under
`.aws-e2e/ag260913a/parity-20260923/`.
