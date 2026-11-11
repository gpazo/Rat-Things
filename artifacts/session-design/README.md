# Session conversation redesign

`session-design.mp4` is a 16-second authored design study, 960×620, with sample
people and agent responses. It is not a live model or AWS recording. Open the
interactive version at `http://127.0.0.1:4177/?scene=session&try=1` after starting
the preview described in `design/shared-workspace/README.md`.

The native console now includes author badges, neutral message text, quieter
reply/copy actions, quoted context, and a progress line above its bounded composer.
Activity opens the latest 20 saved non-message Items. Runtime and raw Turn status
are in Details. Shared workspace navigation sits beside the Session title.
Typing feedback reserves a line so its appearance does not move the composer.
Existing space permissions, message receipts and execution effects are retained.

`native-reply-context.png` and `native-narrow-session.png` show the working native
renderer against deterministic API fixtures. The other images and movie show the
React design study. The compact phone is presentation framing, not an iOS app.

Validation for this pass:

- `npm run check`: passed; 3,070 tests passed, 83 skipped. Packaging, site build
  and all three Terraform validation targets passed.
- `npm run console:check`: passed; 54 unit and 25 native integration tests.
  Five explicitly opt-in tests were not run. Formatting and Clippy passed.
- Prototype TypeScript/Vite build passed. Browser interaction checks at 1280px
  and 390px cover reply cancellation, quoted and unquoted sends, Activity, the
  workspace link, Viewer controls, resize and draft preservation.
- Wide and compact posters, complete flows, marked states and close-up beat
  samples are retained here. The film gate found no forbidden layout faults.
  The flow/state processes returned 2 because timing samples contain gaps;
  continuous motion coverage remains inconclusive. See the component's
  `REHEARSAL.md` for visual review and remaining inspection limits.
- The 390px host-page layout check passed; this checks geometry, not every
  interaction or animation frame.

No new AWS infrastructure or external model API calls were used. Review delegation
used GPT-6 Luna inside Codex; delegated token/dollar charges are not exposed here.
Local infrastructure cost was not metered. This pass did not deploy, commit or push.
