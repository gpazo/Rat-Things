# Local contract and caller review during the AWS soak

This bounded review runs alongside the [AWS observer](aws-live-observer-2026-09-14.md).
No API, worker, observer image or Terraform resource is deployed by this review.
Its changes require later deployment acceptance; the active soak certifies only
its pinned deployment.

## Contract corrections and evidence

The official [Agent create reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/methods/create)
specifies a maximum of 1,048,576 characters for model and instructions. The
configuration resolver counted JavaScript UTF-16 units for those fields, rejecting
valid supplementary Unicode characters early. It now uses a bounded pure
code-point calculation, preserving input content and performing no additional
storage effects. Three focused regressions failed before the change. Five boundary
tests now cover exact-limit creation, over-limit rejection before persistence,
and preservation of the saved Agent after a rejected update.

Agent and Session list bodies now include `first_id` and `last_id`, calculated
from the returned page, with null values for an empty page. This aligns the
[Agent](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/methods/list)
and [Session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/list)
HTTP response examples. The pinned SDK's `CursorPageResponse` defines only
`data` and `has_more`, and the fetched reference does not independently establish
these cursor fields as mandatory schema properties. This is documented-example
alignment, not evidence of a previously violated required-field schema.

Four raw HTTP regressions failed before the response change and now pass. They
check ascending and descending pages, cursor continuation, empty results, owner
isolation and a sparse Session Agent filter spanning more than one storage page.
The combined boundary, list, SDK and Session lifecycle run passes 37 tests.

The current list reference also presents nullable `limit`, while the pinned SDK
types and generated request schema do not. That source difference remains to be
resolved during the exhaustive contract review; this pass does not silently
change request validation or the SDK baseline.

## Cleanup and remaining acceptance

The independent [caller audit](obsolete-caller-audit-2026-09-14.md) records removed
unreferenced artifact catalog and live activity branches, retained consumers and
specific IAM candidates for a later infrastructure review. No retained data is
deleted.

Full `npm run check` passes: 893 tests, 14 opt-in skips, architecture and generated
contract checks, TypeScript, packaging, site build and all three Terraform
validations. Evidence is retained in
`.aws-e2e/ag260913a/parallel-contract-cleanup-check.log`. Targeted retained helper
and publication coverage passes 109 tests. The lower suite count reflects removal
of tests dedicated to dead behavior, alongside new contract regressions.

The long soak, live recovery/multi-agent/tool/integration cases, remaining public
field/Item/event/limit comparisons, and deployment cutover inventory remain open
in the main ledgers. These local corrections do not establish full API parity.
