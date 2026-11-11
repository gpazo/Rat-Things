# Native console visual system

These are actual Rust/egui screens rendered against isolated HTTP services and
deterministic fixtures. They are not React mockups, live AWS screenshots, or
paid-model recordings. Selected earlier screens are in `before/`; the current
rendered set is in `after/`.

The pass unifies the welcome screen, sidebar, Session creation, resource details,
workspace setup and sharing with the conversation/artifact identity. Shared
native theme primitives define introductions, sections, field labels and
navigation. Instructions lead Agent pages; Template pages show packages and
network domains; Vaults retain write-only credential controls. Narrow forms stack
settings, and dialog titles and footers remain outside the scrolling body.

## Screens

| Surface | Wide | Narrow |
| --- | --- | --- |
| Welcome | [Local welcome](after/local-welcome.png) | — |
| Session creation | [1280×850](after/new-session-form-1280x850.png) | [900×650](after/new-session-form-900x650.png) |
| Agent | [1280×850](after/agent-details-1280x850.png) | [900×650](after/agent-details-900x650.png) |
| Template | [1280×850](after/template-details-1280x850.png) | [900×650](after/template-details-900x650.png) |
| Vault | [Credentials](after/vault-1280x850.png) | — |
| Workspace setup | [1280×850](after/local-setup-ready.png) | [900×650](after/local-setup-900x650.png) |
| Artifact feedback | [1280×850](after/shared-artifact-feedback-1280x850.png) | [900×650](after/shared-artifact-feedback-900x650.png) |
| Conversation | [Quoted reply](after/reply-context-1280x850.png) | [Active Session](after/session-active-900x650.png) |

Additional captures cover navigation, credential/template forms and Session copy.

## Validation and review

- `npm run console:check` passed: 54 unit tests and 25 native integration tests,
  formatting and all-target Clippy. Five explicitly opt-in tests were not run.
- `npm run check` passed: 3,070 tests passed, 83 skipped; architecture/schema
  checks, packaging and smoke checks, site build and three Terraform validation
  targets passed.
- Native resize checks exercise retained task text, stacked settings, reachable
  submit, and visible workspace title/footer. Existing held-response and authority
  tests continue to cover state retention, failures, permissions and revocation.
- A fresh GPT-6 Luna subagent reviewed all 18 after frames, five before frames,
  the gold reference and the relevant Rust code. It returned no remaining
  confirmed defect. Its initial observations were withdrawn after full-resolution
  inspection and checking the explicit participant-color requirement. It did not
  run the application itself.

See `design/console-system/REHEARSAL.md` for inspection boundaries. No new live AWS
deployment, paid-provider call, physical touch test, or screen-reader session was
performed. The screenshot set does not cover every Share/team-login state.

No external model API calls or new AWS resources were used. Review delegation
used GPT-6 Luna inside Codex; delegated token/dollar charges are not exposed here.
Local compute cost was not metered. No commit, push or deployment was performed.
