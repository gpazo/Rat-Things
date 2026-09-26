# Remaining Agents API closeout

Release continuation: application commit `5fe5ced` is committed and deployed.
The digest pins in `testing/aws/releases/ag260913a-image.json` select worker
launch-template version 14 and API/relay task revisions 22/19. The original state
lineage is preserved (serial 620 at apply). Local full checks, 423 strict native
image tests, console checks and live scope/model/trace/collector checks passed.
Final expiry, cleanup and merge acceptance is recorded in
[PR #1](https://github.com/gpazo/Rat-Things/pull/1); the sections below preserve the
implementation cycle's original evidence and release-gate rationale.


## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame. Close the annotated expiry, model, permission, behavior-ledger and capacity-six gaps. Preserve AWS ownership and existing trace work.
- [x] Phase B: Design the workflow. Partition read-only discovery across expiry/models, evidence, and a permission-boundary design review. Keep implementation writes serial in this checkout.
- [x] Phase C: Run the loop. Verify each concrete requirement before advancing.
- [x] Establish expiry policy from activity and keep-alives, with a deterministic clock proof.
- [x] Establish the supported model contract from API capabilities, not solely the native CLI menu.
- [x] Add scoped bearer permission enforcement before effects and prove denied requests cannot mutate or infer.
- [x] Correct the six-agent prompt and run the bounded AWS proof with cleanup.
- [x] Reconcile every existing behavior-ledger row with evidence or an explicit unresolved result.
- [x] Phase D: Keep the audit trail. Record decisions and test results below as they occur.
- [x] Phase E: Verify and hand back. Full checks, reviewed diff, exact live image attribution and honest remaining limits.

## Throughput checkpoint

Three independent read-only explorations run alongside local permission tracing.
No concurrent writers share the dirty checkout. Existing OTLP work stays intact.
The critical path is the bounded live multi-agent proof; it can run against the
currently deployed image while local contract fixes are developed, with that
image attribution retained. Final-release deployment is a distinct acceptance
gate and must not be inferred from an earlier-image proof.

## Definition of done

The listed contracts have explicit behavior and relevant passing tests; the
existing evidence ledger has no ambiguous pending prose; the corrected six-agent
proof passes or has a concrete captured blocker. A blocker is not parity.
No merge or new deployment is implied by successful local tests.

## Implementation decisions

- **Expiry:** the service owns retirement. A healthy harness keeps sending durable
  heartbeats between Turns. The pure reconciliation decision expires a verified
  active execution after one hour without a heartbeat. Conditional failure uses
  the captured execution generation and heartbeat before any stop, so a racing
  heartbeat/replacement prevents termination. Unknown/conflicting identity stays
  quarantined; malformed heartbeat evidence is also quarantined. Expiry has its
  own metric rather than being counted as cancellation. Tests cover immediately
  before/at the deadline, races and uncertainty without waiting an hour.
- **Models:** Session updates validate the resolved reasoning configuration
  before persistence. GPT-5.4 Mini accepts `none` and its explicitly documented
  `2026-03-17` snapshot. Service-tier values follow the API schema and are passed
  to the provider, which enforces entitlement/capacity; the native interactive
  catalogue is not an API tier allowlist. The supported update matrix and initial
  provider-specific model distinction are published in `docs/agents-api.md`.
- **Permissions:** authenticated principal values carry owner and scopes. Pure
  boundary checks run before service effects. Tokens persist scoped grants and
  expire after 15 minutes. IAM-only issuance permits narrowing, including no
  scopes; no bearer escalation is available. Inference permission applies to
  initial input and an entire message/tool-result batch before even a leading
  cancellation is applied. Traces permit Agents read or dedicated trace read;
  Vault authority is separate. Explicitly scoped clients reject legacy or
  overbroad issuer responses. Direct IAM authority and OpenAI account/key
  administration are explicit operator differences. Old unscoped stored grants
  fail authentication and must be refreshed after deployment.
- **Item/event evidence:** the literal missing assertions were historical image
  replay and close-agent projection/lifecycle. The latter exposed a replay bug:
  repeated closure notifications changed `closed_at`. Closure now retains its
  first timestamp until reopening. Added MCP/command result/error correspondence
  and MCP/search interruption assertions close the remaining family wording.
  Existing nested identity, function namespace/output, restored native history,
  compaction and causal-order tests provide the other evidence.
- **Workflow:** pstack's Model the Domain separated pure authorization/liveness
  decisions from effects; Prove It Works kept the ledger tied to literal test
  assertions. Read-only design review caught scoped clients accepting an older
  issuer's unrestricted token, and expiry being mislabeled as cancellation. Both
  are corrected. No concurrent implementation writers were used.

## Corrected AWS capacity-six proof

The prompt now targets the child's native name while public assertions retain
its public ID. All six children occupy capacity, overflow fails, three interrupted
follow-ups retain identity and typed initial task content, and a final follow-up
completes. The clean run passed in 218 seconds, including Session/Agent deletion.

- Deployed application: `a766b7a`; launch template `lt-0c212465a940ad6ae`, version 13.
- Worker digest verified from AWS template data:
  `sha256:83e2f70c3ffdf6be5bc7a360e8cb6628ca2527dd2d6f45a0d09281e937c73af0`.
- Accepted Session: `sess_c9986dc45c2446f289d65eb9a138dd6b`; post-test retrieval 404.
- The first corrected run passed all behavior assertions but failed cleanup with
  a concurrent-write 409. Cleanup was retried and deletion verified as 404 for
  `sess_c3c6d212b4fb4d8fad2190ab737f030e`. The fixture now uses bounded SDK retries
  during cleanup. That failed run is retained, not represented as a clean pass.
- Deployment-tagged pending/running EC2 inventory was empty after both cleanups.
- Logs: `.aws-e2e/ag260913a/closeout-20260925/capacity-six-pass.log` and
  `capacity-six-cleanup-conflict.log`.

This establishes the corrected six-child proof on the existing deployment. It
is not AWS evidence for the local expiry, scope, trace or closure-replay changes.

## Remaining release and cleanup gates

The fixed behavior inventory is reconciled in `agents-api-conformance.md` and
`agents-api-item-event-audit-2026-09-14.md`. No open-ended "broader variants" gate
is added. The earlier feature audit and closeout are historical baselines.

Before a production parity claim, commit and pin one candidate, deploy its exact
images/Lambda archives using the retained Terraform state, and validate the
changed scoped-token/trace paths and expiry/closure behavior against that
candidate. Do not rerun unaffected provider/file/MCP matrices without a change
or failure justifying it. Review and merge remain separate from local completion.

Intentional contract boundaries remain published: AWS IAM/owner identity instead
of OpenAI organization/project administration; the enumerated model-update
support set; provider model/tier entitlement; structural traces without secrets
or retrospectively reconstructed spans. These are not claims of equivalence to
every OpenAI deployment/account behavior.

Obsolete public API/coordinator/grants are already removed. Old deployment data,
bindings, replaceable fixtures/media and optional binary-size work remain in
`obsolete-implementation-removal.md` and `obsolete-caller-audit-2026-09-14.md` for
a separate cleanup cycle. No retained data was deleted as part of this change.


## Final local verification

`npm run check` passed with the matching Linux ARM64 runtime artifact. It includes
architecture and generated-contract checks, TypeScript, 1,119 passing tests
(47 opt-in skips), packaging/bundle smoke checks, site build and all three
Terraform validations. `git diff --check` passed. Full log:
`.aws-e2e/ag260913a/closeout-20260925/check.log`.

Changes remain uncommitted and undeployed. The previous strict native-image
acceptance remains attributable to its recorded release; this turn ran ordinary
native fixtures through the full check and the corrected live multi-agent proof,
not a new strict native-image suite. No new heartbeat or soak was scheduled.
