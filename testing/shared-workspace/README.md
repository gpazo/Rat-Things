# Live shared workspace proof

`live.ts` exercises one real AWS Session using independent OIDC identities for a
designer, engineer and QA collaborator. An additional viewer and outsider check
permission boundaries. The three collaborators keep activity streams open while
they annotate the same captured browser page. The proof first starts an idle Session and verifies its browser before submitting
any model input. A fixed HTML fixture is supplied through the environment files;
the real agent opens it through the worker-owned browser and creates its Session Plan. It then receives
and acknowledges feedback, updates the Plan through its admitted tool, and links
the resulting saved output.

QA types a random visual code into a page field; it is never included in the
feedback text. The agent must read it from the captured image.

The proof checks shared navigation, element and region anchors, replies, identity
colors, duplicate submission, reconnect and revocation. It moves the live page
after capture, verifies each feedback receipt in the Plan, reads result bytes and
checks their hashes and feedback content, and checks immutable Plan revisions.
Resolve/reopen remains covered by the zero-inference harness below. It saves
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

The script rejects another model and disables SDK retries. Native Codex provider
retry defaults remain bounded separately; SDK settings do not change them. It limits the scenario
to twenty minutes, four observed Turns, twenty observed tool Items and 250,000
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

For the bounded subscription Plan acceptance, build or select the local worker
image first. Use the existing `~/.rat-things/multiplayer-demo` sign-in, verify
that the selected model appears in its local Codex catalog, then run:

```sh
RAT_LIVE_SHARED_PLAN=1 node --import tsx testing/shared-workspace/plan-local.ts \
  --directory "$HOME/.rat-things/multiplayer-demo" --model gpt-6-luna
```

The model is mandatory and there is no fallback. The runner uses the container
runtime and real `LocalSessionExecution`, makes at most four Turns, twenty tool
calls and 250,000 observed tokens, and stops at twenty minutes. It saves a
sanitized evidence file and captured frame under
`artifacts/shared-workspace/live-local/`, then deletes only its Session and
worker volumes. It preserves the existing account profile. Local subscription
billing is not exposed by this harness; usage is recorded when the runtime
reports it, and missing usage or cost is labeled explicitly. This does not test
OIDC authentication, the native desktop UI, or load performance. Collaborator
permissions come from in-process `SessionCaller` objects.

## Review shared browser sizes in the native console

Build the local Linux image, then run the focused two-client scenario:

```sh
RAT_BROWSER_REVIEW=true TMPDIR=/private/tmp \
  cargo test --locked --manifest-path desktop/Cargo.toml \
  --test shared_browser_review -- --ignored --nocapture --test-threads=1
```

Use Node 22.20 or newer on `PATH`. The test opens the saved Taco Cometa fixture,
switches the shared browser to Phone, follows its menu link, scrolls, and publishes
captured feedback while the other client restores Desktop. It reopens the original
phone capture without changing the live viewport. The browser, local Linux worker,
Session services and native clients are real; model replies and loopback identities
are fixtures. No paid inference or AWS resource is used.

Screenshots, activity and cleanup evidence go to
`artifacts/shared-workspace/taco-refinement/`. The server removes its worker,
paired volumes and temporary profile. This scenario does not replace OIDC,
live-provider or load tests. It uses a 60 Hz native event clock so scripted clicks
remain clicks instead of exceeding egui's long-press threshold.

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

The journey covers shared typing, point and region selections sent through the
ordinary composer, participant colors, and delivery of the captured image to
Codex. Scripted model tool calls update the agent-owned Plan with source links,
addressed and deferred decisions, and a link to a seeded output document. The
Plan is persisted by the real host tool; its decisions are fixture content.
Raw native renders and timing metadata are saved in
`test-results/shared-workspace-demo/`; evidence is saved under
`artifacts/shared-workspace/feedback-demo/`. The server removes its own worker,
paired volumes and temporary profile on shutdown.

With Pillow installed in a Python environment and `ffmpeg` on `PATH`, compose the
actual captures into a video:

```sh
python testing/shared-workspace/render-demo.py --preview
python testing/shared-workspace/render-demo.py
```

The edit uses crops of genuine native renders. Names and colors identify whose
client is shown; captions explain the contribution and the resulting decision.
Scripted replies and edited timing are disclosed throughout. This is a workflow
demo, not a latency benchmark or a new live-provider validation. An SRT caption
file, cover, shot previews and source-image hashes accompany the video.

`feedback-edit.json` contains frame ranges, crop rectangles, captions, durations
and holds. Its manifest digest prevents a new capture silently reusing stale
frame offsets. After recording again, inspect `frames.json`, retime the ranges,
update the digest and review the preview at ordinary player size. Keep selections,
author names and source links readable; crops must not repaint or rearrange UI
content. The earlier recording remains under `artifacts/shared-workspace/demo/`.

The renderer also accepts `--edit`, `--source` and `--output` paths for alternate
cuts. Keep the fixture disclosures attached when sharing a recording.
