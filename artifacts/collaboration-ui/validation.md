# Multiplayer colors, typing and replies

Validation on 2026-11-08, branch `codex/participant-colors`, based on
`30fcb4a2ddac1ae9a40ee46d6418b6901e70f88e`. Changes are not committed or deployed.

## Results

- Repository check stages passed: architecture, generated contracts, TypeScript,
  MicroVM syntax, unit/integration tests, Lambda packaging and bundle smoke checks,
  site build, and formatting/validation for all three Terraform configurations.
- TypeScript suite: 3,054 passed, 84 skipped across 333 passing files and 35 skipped
  files. Focused collaboration, presence and authorization suite: 30 passed.
- Native check stages passed: formatting, Clippy on all targets with warnings denied,
  53 library tests and 22 console integration tests. Four explicit opt-in native
  tests were ignored (browser, live AWS, live local Pi, walkthrough recording).
- Native console tests use real widgets and a local HTTP service with fixture
  execution. They cover selecting Reply, sending it, saving the reference and
  reopening the Session. The fixture does not run a model or provision a worker.
- A 50-concurrent-contributor fixture verifies distinct stable colors and durable
  input handling. It is a correctness test, not a deployed load/latency benchmark.
- Core and route tests cover reply target validation, authenticated attribution,
  pending-message replies, idempotent retries, viewer rejection, revoked access,
  typing expiry, delayed sequences and multiple clients per identity.
- `multiplayer-wide.png` and `multiplayer-narrow.png` show actual native widgets
  with fixture content, inspected at 1280×850 and 720×850 respectively.

The combined checks initially hit local disk exhaustion. Native checks and packaging
were rerun sequentially and passed. Task-generated Rust build and packaging outputs
were removed afterward to recover disk space; screenshots and source are retained.

After replacing the visible “Cancel reply” text with a compact × button,
`npm run console:check` and `npm run check` both passed again. The existing native
test confirms the accessible “Cancel reply” label and draft preservation.
The screenshots reflect this updated button.

## Not exercised

No AWS deployment, real OIDC-provider login, multi-machine UI session, paid inference,
live subscription inference, network-chaos test or deployed performance benchmark
was run for this change. Existing explicit opt-in tests remain opt-in.

## Decisions

- Typing is ephemeral: no draft text, model input or durable feedback history. The
  server enforces collaborator access, a six-second lease and per-window sequences.
- Replies remain in the main conversation. Saved receipts carry the target ID,
  server-resolved author and a bounded quote that is marked untrusted in model input.
- Colors belong to Session identities, never roles. Existing assignments remain
  stable; imported author claims have separate identity keys. Large groups may have
  visually similar colors, so names remain visible.
- Public Agents API Item shapes stay unchanged. Collaboration uses private Rat
  Things endpoints and attributed input receipts.
