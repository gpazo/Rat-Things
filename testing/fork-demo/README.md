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
