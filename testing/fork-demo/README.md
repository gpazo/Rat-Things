# Fork studio contributor harness

`npm run demo:fork` serves the no-cloud walkthrough on port 4174. Its static assets
also ship with the documentation site at `/fork-demo/`.

`npm run demo:fork -- --live` uses `RAT_THINGS_AGENTS_API_URL`, `AWS_REGION`, and
`AGENT_MODEL`; the deployment must enable Session checkpoints and S3 Files. This is
an explicit, billed opt-in. The local controller records only resources it creates
and deletes the unchosen child when the user selects a winner. Use the UI's cleanup
action before removing a disposable deployment. Browser credentials never contain
AWS or API credentials. The retained local state is ignored by Git.

Verification:

- `npx vitest run tests/agents/fork-demo.test.ts`: ownership, interrupted cleanup,
  concurrent action admission, and choosing either branch.
- `npm run test:e2e:site -- e2e/site/fork-demo.browser.ts`: desktop and mobile UI,
  both choices, reset, download, offline operation, and viewport fit.
- Live browser check: run the same prepare/fork/choose/download path against
  `?mode=live`; inspect the saved controller state and verify the loser returns 404
  while the winner and original remain readable. Then use cleanup and confirm all
  three Sessions and the Agent return 404. Store evidence under `.aws-e2e/`.

QA inventory: initial brief and action; ready-to-fork state; both independent
previews; either winner with the discarded card; downloadable HTML; retry/reset;
mobile layout; real-mode progress, error, reload and cleanup. Do not represent the
walkthrough as evidence of live AWS execution. Preview frames are sandboxed and
block scripts, forms and external asset loading.

## Render the demo video

The shareable deliverable is `assets/session-fork-demo.mp4`: 68 seconds, 1920 × 1080,
24 fps, H.264 with burned-in captions and no audio. The poster sits beside it.

With FFmpeg/ffprobe on PATH and Playwright Chromium installed:

```bash
npx playwright install chromium --only-shell
npm run demo:fork:video -- --preview-only
npm run demo:fork:video
```

The first command after installation writes storyboard frames to
`test-results/fork-video/`; the full render streams frames directly to FFmpeg to
avoid a large intermediate recording. Inspect these frames and the exported MP4
for framing, text fit, scroll motion, cursor placement, and the keep/discard outcome.
The renderer checks browser errors, artifact hashes, duration, codec and dimensions;
export metadata is written to `test-results/fork-video/export.json`.

`scripts/fork-video/scene.html` is a recording-only presentation stage, not a
product interface. Its selection sequence replays the verified outcome, without
calling AWS. The five unmodified generated HTML files are under `fixtures/` and
their hashes and provenance are in `scripts/fork-video/provenance.json`. Displayed
prompts summarize the live instructions. The persistent on-screen replay label
distinguishes the edited video from a fresh execution or a real-time screen capture.
No active Session identifiers or credentials are embedded in the film.

The recording stage inherits its palette and brand mark from `site/docs.css`.
Keep the video framing aligned with the documentation's blue-black, cyan, and
amber theme; the generated designs inside preview frames retain their own styles.

## Capture five real alternatives

The browser companion keeps its two-path flow. The capture harness uses all five
entries in `testing/fork-demo/directions.ts`; the controller accepts a configurable
set and persists each discarded child separately so interrupted cleanup can resume.
As with the live server, use an explicitly opted-in deployment with checkpoints,
S3 Files, `RAT_THINGS_AGENTS_API_URL`, `AWS_REGION`, and `AGENT_MODEL` configured.
For the disposable AWS harness, set `TF_VAR_session_checkpoints_enabled=true`
before deploying; checkpoints default to disabled.

```bash
export FORK_DEMO_CAPTURE_DIR="$PWD/.aws-e2e/my-run/fork-capture"
npm run demo:fork:capture -- --live prepare
# Inspect all five saved HTML files at desktop, preview and mobile widths.
npm run demo:fork:capture -- --live choose direction_key
npm run demo:fork:capture -- --live cleanup
```

Use one capture process per directory. Prepare creates the source and five real
children, saving their artifacts and hashes. Choose accepts only a recorded branch
key and verifies that the original and winner remain readable while all four
others return 404. Cleanup verifies all recorded Sessions and the Agent are gone.
Keep the inventory until cleanup succeeds; an interrupted prepare must be cleaned
up before retrying. Artifacts and proof remain available after resource cleanup.

Review the actual artifacts before writing `scripts/fork-video/evaluation.json`.
Record a specific strength and tradeoff for every option, mobile and desktop pan
distances, qualitative ratings in the displayed criterion order, and a reason for
the selected winner. These are editorial assessments, not automatic benchmark
scores. Update the fixture hashes and selection proof in `provenance.json` from
the capture evidence, then render and inspect the film.
