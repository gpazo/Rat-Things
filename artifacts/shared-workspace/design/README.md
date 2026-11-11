# Shared workspace redesign

`workspace-design.mp4` and the posters illustrate the proposed interaction using
local sample state. They are labelled design material; they are not a live model
or AWS recording. Open the interactive study with the instructions in
`design/shared-workspace/README.md`.

The working native console implements:

- Work beside Conversation or artifact Feedback in a wide window.
- Work/Discussion navigation in a narrow window.
- Independent drafts retained across those views, with a bounded feedback composer.
- Contributor names in their stable Session colors.
- Existing browser frame fencing, captured annotations, roles and activity services.

Validation for this pass:

- Repository `npm run check`: passed, 3,070 tests passed and 83 skipped; packaging,
  site build and three Terraform validation targets passed.
- `npm run console:check`: passed, 53 unit tests and 25 native integration tests;
  five explicitly opt-in tests were not run. All-target Clippy also passed after
  updating the recording harness to select the Feedback tab.
- Prototype TypeScript/Vite build and interactive checks at 1280px and 390px passed.
  The checks cover per-artifact drafts, reply cancellation, actor changes, viewer
  controls and the people popover. Results: `interaction-checks.json`.
- Visual gate reports, contact sheets and sampled beats are retained here.
  Sampling gaps and visual-review limits are described in the component's
  `REHEARSAL.md`; a green layout gate does not certify every animation frame.

No new AWS infrastructure or external model API calls were used. Review delegation
used GPT-6 Luna inside Codex; delegated token/dollar charges are not exposed here.
Local infrastructure cost was not metered. No deployment, commit or push is part
of this design pass.
