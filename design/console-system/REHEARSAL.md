# Rehearsal: native console system

This pass applies stageshow's hierarchy, density and inspection workflow to the
actual Rust/egui application. It extends the shared conversation and artifact
identity into the surrounding console. The earlier copied and filmed `ai-chat`
and `panel-annotation` examples are the composition references. The native
application uses its own controls; these captures are not authored React scenes.

## Captures

Screens are rendered by the existing native integration harness against isolated
HTTP services and deterministic worker/credential fixtures. No external model
calls are involved. See `artifacts/console-system/after` for the current captures
and `before` for selected earlier surfaces.

Wide: 1280×850. Narrow desktop: 900×650. The captured set includes welcome,
navigation, Session creation, Agent details, Template creation and details,
credential creation and Vault details, workspace setup, copying, conversation,
and the shared artifact workspace. These are desktop layouts, not a mobile app.

## Iteration

- Aligned the resource reading column with the conversation and used shared native
  page, section, label and navigation primitives.
- Kept Agent instructions visually prominent; reduced the surrounding metadata
  rather than enclosing every element in an identical card.
- Expanded setup dialogs, constrained their scrolling body, and fixed a footer
  that consumed extra height and pushed the title offscreen after resizing.
- Stacked model/environment fields at narrow widths while preserving the draft
  and leaving Create reachable outside the scroller.
- Moved notification overlays below the revised header after a saved-credential
  notice intercepted the Actions menu. The full service journey exercises that
  menu again after credential revocation.
- Inspected the rendered welcome suggestions, outline navigation glyphs, form
  controls, reading widths, card insets, and narrow dialog title/footer.

## Verification boundaries

The native suite includes held responses, failed refreshes, navigation during
requests, retained drafts, authority changes and revocation. Added resize checks
cover field ordering, retained task text and on-screen submit/title/footer bounds.
Formatting, Clippy and the native suite passed after these corrections.

The repository-wide check also passed, including 3,070 tests, packaging, site
build and three Terraform validation targets. The native suite passed 54 unit
and 25 integration tests. Opt-in live tests remained skipped.

## Independent review

After the implementation and rendered pass, a fresh GPT-6 Luna subagent inspected
all 18 current frames, five earlier frames, the gold, and the changed native
presentation code. It returned no confirmed defect. Three initial flags were
withdrawn: the wide feedback composer is visible at the bottom of the frame;
participant identity colors are an explicit user requirement and documented
brand exception; and ordinary scroll clipping was not a demonstrated stale-state
bug. No changes were made to remove correctly functioning or authorized behavior.
The reviewer did not run the application; interaction coverage comes from the
native harness, not its still-frame review.

No new authored animation is shipped in this pass, so the browser film gate is
not a validator for these egui screens. No new live AWS deployment, paid-provider
run, physical touch test, screen-reader session, or frame-by-frame animation
recording was performed. The Share dialog's behavior is covered by the native
state tests; the screenshot set does not include every team-login/share state.
