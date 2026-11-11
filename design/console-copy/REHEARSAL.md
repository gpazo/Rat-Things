# Rehearsal: native console copy

Gold references: stageshow `ai-chat` and `panel-annotation`, already copied and
captured in the preceding native design studies. Their restrained hierarchy and
short action labels guide this editorial pass. Rat Things keeps its native dark
palette, real controls, participant identity colors and working application layout.
Unlike the cropped gold illustrations, the console retains functional empty space
and real content throughout; it does not substitute bars for user data.

## What changed

Removed promotional welcome text, starter descriptions, repeated section captions,
form introductions that repeated the form's purpose, and duplicate annotation
guidance. Shortened setup, sharing, picker and recovery text. Empty states avoid
suggesting unavailable actions. Empty artifact lists no longer ask the user to
choose an artifact. Copy counts use the correct singular forms.

The presentation helpers omit absent descriptions and their spacing. Starter
buttons fit a single line. Prompts, permissions, data contracts, background effects
and control actions retain their existing behavior.

Decisions preserved in visible copy: local versus AWS execution; connecting versus
copying versus moving a Session; credential handling; role limits; verified versus
imported attribution; fixed capabilities; file-version and browser-capture context.
The brand voice guide now makes the editorial rule explicit, and documentation
uses the current control labels.

## Frames inspected

All 18 frames in [`after/`](../../artifacts/console-copy/after/):

- Local welcome and compact Session sidebar.
- New Session at 1280×850 and 900×650.
- Agent details at both widths.
- Template creation and details at both widths.
- Vault and credential creation.
- Workspace setup at both widths and reviewed Session copy at 900×650.
- Reply context and active Session composer.
- Artifact feedback at both widths.

These are Rust/egui renders exercised by the native test harness against the local
fixture service, not a new React mockup or edited screenshots. Both widths retain
their controls. The narrow feedback view uses its existing Work/Discussion tabs;
setup uses a bounded scrolling body and fixed Done button.

## Independent review

A fresh GPT-6 Luna subagent inspected all 18 frames, both gold captures and the
native presentation modules without the builder's plan or rationale. Its single
finding was that “Saved on this computer” did not identify what was saved, while
“your provider” was vague. The final line says:

> Sessions are saved on this computer. Conversation content goes to your model provider.

The targeted native welcome test passed and the frame was recaptured after this
change. The reviewer inspected that frame again and confirmed the finding was
resolved. It found no other substantiated copy issues in the shown states.

## Validation

- `npm run console:check`: formatting and strict clippy passed; 54 unit and 25 native
  integration tests passed. Five opt-in tests remained ignored.
- The initial restart-copy assertion was updated to match the new wording; the
  full native suite then passed.
- A redundant empty-description match was simplified after the full native run;
  strict clippy passed again. The review follow-up also recompiled the final UI
  and passed the focused welcome workflow.
- Final `cargo fmt --check` and `git diff --check` passed.
- `npm run check` passed: 3,070 tests passed and 83 opt-in tests were skipped;
  architecture/schema/route checks, typechecking, Lambda packaging and smoke tests,
  site build, Terraform formatting and all three Terraform validations passed.
  Full log: `.codex/pstack-runs/console-copy/check.log`.

## Limits

No new AWS deployment, paid model calls, Linux VM provisioning or live identity
provider sign-in was run for this presentation pass. No macOS screen-reader,
cross-platform native-window or large-text audit was performed. Native interaction
tests exercise async loading, draft retention, recovery and permission behavior;
still frames alone do not establish those behaviors. The stageshow browser-film
gate and animation seam checks do not apply to this native copy-only pass.
