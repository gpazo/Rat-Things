# OTLP export and Session update validation

Implements priority 1 from the September 25 feature audit. This change has not
been deployed to AWS or merged; previous live deployment evidence does not test
these new behaviors.

## Implemented

- Owner-scoped `GET /v1/agents/sessions/{session_id}/traces`, including cursor
  pagination, `first_id` and `last_id`, schema discovery and the Terraform route.
  The documented endpoint is an explicit addition to the pinned SDK inventory.
- Pure capture of allowlisted structural native events, retained in the existing
  encrypted Session runtime journal and terminal Session history. Later child
  observations can refresh retained history without rewriting identical state.
- Deterministic OTLP JSON projection with owner-separated trace identities,
  parent/child Turn binding, agent/tool/generation spans, outcomes and available
  usage. Missing generation start observations remain explicitly completion-only.
- `sessions traces SESSION_ID --output PATH` collects every available page into
  one OTLP payload. Without `--output`, it prints one API page.
- `local --trace-output PATH` captures local execution without an AWS Session or
  a collector. CLI file creation uses mode 0600. The user chooses whether to send
  that payload to a collector; the backend has no collector credentials, delivery
  queue or automatic forwarding.
- Session updates validate the resolved settings against the installed model
  capability policy before persistence. Rejected updates leave metadata and
  settings unchanged; accepted updates still affect only future Turns.

## Deliberate boundaries

Trace exports omit prompts, instructions, tool arguments/results, credentials,
private reasoning and arbitrary native payload fields. They describe recorded
structure, timing and counts rather than offering a content replay. Older work
does not gain retrospective tool/generation observations. Collector delivery is
user-operated, and trace export is a snapshot rather than a subscription.

The capability policy is an explicit supported model matrix, not a provider
discovery service. Its native reasoning baseline comes from the pinned catalogue
whose SHA-256 is recorded in `runtime/codex/model-capabilities.json`, with the
documented GPT-5.2/GPT-5.4 `none` support included. Provider access, regional
availability, and expanding the model matrix remain separate concerns. Do not
infer unrestricted model or account-permission parity from this validator.

## Verification scope

Final `npm run check` passed: 1,102 tests passed and 47 opt-in tests skipped,
with schema/route checks, type checking, Lambda packaging and smoke checks,
site build, Terraform formatting and all three Terraform validation targets.
The separate local mock CLI smoke also produced an OTLP file successfully.
No live AWS proof or external collector ingestion test was run for this change.

Focused tests cover trace redaction, timings and replay, stable IDs, owner
separation, child attribution across root Turns, pagination and CLI export,
retention after runtime removal, local CLI capture, and atomic rejection of
unsupported settings. The native Session fixture exercises trace projection on
actual harness events. Full repository checks use the previously verified ARM64
artifact at `.aws-e2e/ag260913a/parity-20260923/ci-artifact/runtime` because the
default local artifact predates the current native patches.

Sources: [Agents tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing),
[Session configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration),
[model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4).
