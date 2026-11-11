# Live shared workspace proof

`live.ts` exercises one real AWS Session using independent OIDC identities for a
designer, engineer and QA collaborator. An additional viewer and outsider check
permission boundaries. The three collaborators keep activity streams open while
they annotate the same captured browser page. The proof first starts an idle Session and verifies its browser before submitting
any model input. The agent then creates the page, opens
it through the worker-owned browser, then receives and acknowledges feedback.

QA types a random visual code into a page field; it is never included in the
feedback text. The agent must read it from the captured image.

The proof checks shared navigation, point and region anchors, replies, identity
colors, duplicate submission, resolve/reopen, reconnect and revocation. It saves
sanitized observations and actual browser screenshots under
`artifacts/shared-workspace/live-aws/`. These clients exercise the deployed API and
streams; they do not prove three native desktop windows render correctly.

Use the disposable AWS harness with `AWS_E2E_REAL_CODEX=true`,
`AWS_E2E_SHARED_SESSIONS=true`, `AWS_E2E_ENABLE_MICROVM=true` and
`AWS_E2E_CODEX_MODEL_ID=openai.gpt-5.6-luna`. After deployment, source that stack's
private `runtime.env`, then run:

```sh
node --import tsx testing/shared-workspace/live.ts
```

The script rejects another model and disables SDK retries. It limits the scenario
to twenty minutes, four observed Turns, twenty observed tool Items and 100,000
observed tokens, with a $1 inference stop threshold. These are controller-side
checks, not an atomic provider billing cap: in-flight usage can arrive after an
observation. Prices are recorded with their source in the evidence; infrastructure
billing is separate. Do not rerun paid inference without diagnosing a failure.

The script removes its Session, Agent and temporary Cognito users in `finally`.
Always run `scripts/aws-e2e-destroy.sh <deployment-id>` afterward, including after
interruption. The space and retained audit records disappear with the disposable
stack. Never copy `runtime.env`, credentials, Terraform state or bearer tokens
into evidence.

For zero-inference browser coverage, set `RAT_BROWSER_TEST_BINARY` to a dedicated
headless-shell binary and run `tests/runner/shared-browser.test.ts`. Do not point
it at a personal Chrome profile or full desktop Chrome. The native console tests
and screenshots cover rendering separately; Docker must be available for the
local isolated Linux runtime.

For local Linux acceptance, build the worker with `npm run runtime:local:build`,
then run:

```sh
RAT_LOCAL_WORKSPACE_PROOF=true node --import tsx testing/shared-workspace/local.ts
```

This uses the real container worker, Codex protocol and SQLite services with a
loopback model fixture; it makes no paid inference calls. It checks browser use
between Turns, captured-image feedback, idempotency and durable annotations after
a graceful service restart. It saves a frame and sanitized results under
`artifacts/shared-workspace/live-local/` and removes its temporary profile,
container and paired volumes. It is not a native desktop UI or subscription test.

## Record the multiplayer desktop journey

After building the local Linux image, run the opt-in native capture:

```sh
RAT_SHARED_WORKSPACE_DEMO=true TMPDIR=/private/tmp \
  cargo test --locked --manifest-path desktop/Cargo.toml \
  --test shared_workspace_demo -- --ignored --nocapture --test-threads=1
```

Use Node 22.20 or newer on `PATH`; `NODE` can select its executable. The capture
drives three independent instances of the production `ConsoleApp` through native
controls. The local Session service, SQLite persistence, Codex protocol, isolated
Linux worker and Chromium are real. Authentication uses three demo-only loopback
tokens, and model responses come from a deterministic Responses fixture. This is
not an OIDC-login, subscription-inference or operating-system window-management
test. No model API is called.

The journey covers shared typing, one live page, point and region feedback,
replies, author colors, resolve/reopen and delivery of the captured image to
Codex. Raw native renders and timing metadata are saved in
`test-results/shared-workspace-demo/`; sanitized evidence is saved under
`artifacts/shared-workspace/demo/`. The server removes its own worker, paired
volumes and temporary profile on shutdown.

With Pillow installed in a Python environment and `ffmpeg` on `PATH`, compose the
actual captures into a video:

```sh
python testing/shared-workspace/render-demo.py
```

The resulting 75-second MP4 uses readable crops of the genuine native renders.
It briefly compares all three clients for typing, browser state and shared
feedback. Names and colors identify whose client is shown. Captions distinguish
the live browser from the captured page used for annotations. The footer labels
scripted replies and edited timing throughout; this is not a latency benchmark.
An SRT caption file, cover, shot previews and source-image hashes accompany it.

`share-edit.json` contains the source frame ranges, crop rectangles, captions,
durations and holds. Its source-manifest digest prevents a new capture silently
reusing stale frame offsets. After recording again, inspect `frames.json`, retime
the ranges, update the digest, and preview before encoding:

```sh
python testing/shared-workspace/render-demo.py --preview
```

Review the resulting images under `artifacts/shared-workspace/demo/review/` at
both full size and ordinary player size. In particular, check that a selected
region and the full posted feedback remain visible. Crops must not repaint or
rearrange UI content. Preserve the original walkthrough when making an editorial
cut; the share edit omits resolve/reopen and crops a single response from the
original fixture's repeated summaries.

The shareable explanation and suggested accompanying copy are in
`artifacts/shared-workspace/demo/README.md`. Keep fixture disclosures attached
when sharing the recording.
