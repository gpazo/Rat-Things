# Two AI participants in one local Session

`server.ts` starts one shared Session on the production local services: SQLite,
the Codex protocol, the isolated Linux worker, the shared browser, attribution and
activity streams. Inference is real and uses the ChatGPT subscription signed in to
the demo profile. Only participant authentication is demo-specific: Claude Code and
Codex CLI each receive a loopback bearer token with the collaborator role. There is
no OIDC sign-in.

Sign in once. The profile is separate from `~/.codex` and your normal workspace:

```sh
RAT_THINGS_LOCAL_DIR=$HOME/.rat-things/multiplayer-demo npm run rat-things -- login
```

Start the server with an explicit model from the subscription catalog. It refuses
an unknown model rather than falling back. Keep stdin open; closing it shuts down
the server and removes the worker container and its paired volumes:

```sh
sleep 7200 | CODEX_BINARY=$PWD/node_modules/.bin/codex RAT_AGENTS_LIVE=true \
  RAT_AGENTS_LIVE_MODEL=gpt-6-luna node --import tsx testing/shared-workspace/agents-live/server.ts
```

The server accepts contributions only for the demo Session. The bounded run defaults to
four Turns, 1.2 million observed tokens, 120 tool items, 35 minutes of active work and
10 minutes of review. Reaching the Turn limit rejects additional inference while letting
the last admitted Turn finish. Reaching a token, tool-item or active-time limit pauses
inference, requests cancellation of any active Turn, and leaves the Session, browser,
history and feedback routes available during review. The server cleans up at the review
deadline, or immediately when stdin closes or it receives SIGINT/SIGTERM.

On cleanup, it saves activity, per-Turn token usage, the latest HTML artifact when it is
at most 1 MiB, budget/review and cancellation status, and cleanup outcomes under
`artifacts/shared-workspace/agents-live/`. The HTML export is `latest.html`; cleanup
metadata is in `cleanup.json`. If cleanup fails, the process exits with an error and
records which resources could not be removed. The demo profile and its sign-in remain
available for the next run. The selected model uses the signed-in ChatGPT subscription,
not an API key or API-billed inference.

## Independent teammates through the native UI

For a bounded usability simulation, set `RAT_AGENTS_LIVE_SCENARIO` to an operator-owned
JSON file with `participants` (`name`, `label`), `instructions`, `maxObservedTokens`
and `maxToolCalls`. It supports one to four identities. Token and tool ceilings may be
set up to 2,000,000 and 200 respectively. Optional `maxTurns`, `maxActiveMinutes` and
`reviewMinutes` fields tune the run within caps of 20 Turns, 60 active minutes and 30
review minutes. The defaults are four Turns, 1.2 million tokens, 120 tool items, 35
active minutes and 10 review minutes. The server also accepts `RAT_AGENTS_LIVE_MAX_TURNS`,
`RAT_AGENTS_LIVE_MAX_MINUTES` and `RAT_AGENTS_LIVE_REVIEW_MINUTES` when there is no
scenario override. Set
`RAT_AGENTS_LIVE_CONNECTION` and `RAT_AGENTS_LIVE_OUTPUT` to keep the private
connection file and exported evidence separate. Token/tool ceilings inspect reported
activity; they are not provider-enforced limits on a running request. Missing token
usage remains pending and does not count as a reported zero.

The ignored `desktop/tests/team_simulation.rs` test drives a production `ConsoleApp`
through native controls. Run a separate test process for each participant with
`RAT_TEAM_SIMULATION=true`, `RAT_TEAM_PARTICIPANT=<name>`,
`RAT_AGENTS_LIVE_CONNECTION=<private file>` and `RAT_TEAM_SIMULATION_UI=<directory>`.
The default driver names are `client`, `designer`, `engineer` and `qa`.

Write each command atomically as `<directory>/<name>/requests/<id>.json`. The driver
writes `<id>.result.json`, a screenshot, and the original request alongside it.
Browser actions and message submissions wait up to 10 seconds for their own outcome. A rejected action
returns its error; a still-running action returns `pending: true` and `ok: false`.
Routine frame polling does not count as a pending user action.
Commands include `inspect`, `click` with an observed `label`, `fill` with a label
and text, `say` with text, and `press` with Escape, Enter or Tab. `point` takes
normalized `at: [x, y]` coordinates in the visible preview: it clicks the live page
normally and creates an anchor in annotation mode. `region` additionally takes
`to: [x, y]`. Browser controls expose scrolling and keyboard input. `resize`
changes the console dimensions, not the shared page's viewport.

Use the native `Phone viewport` and `Desktop viewport` controls to resize the
shared browser itself. The driver advances egui at 60 Hz; do not restore the test
library's 250 ms default, which can turn a multi-step scripted click into a long press.

Each process stops after 45 minutes or when `<directory>/stop` exists. Stop the
server separately to remove its worker and volumes. This is a headless native
component exercise, not OS-window automation or an OIDC test. Generated source
uses the application's missing-glyph fallback rather than the test library's
default panic. Preserve independent feedback before performing assisted follow-up
checks, and separate driver limitations from product findings in the report.

Each participant uses the same client:

```sh
node --import tsx testing/shared-workspace/agents-live/participant.ts claude say "…"
node --import tsx testing/shared-workspace/agents-live/participant.ts codex transcript
node --import tsx testing/shared-workspace/agents-live/participant.ts codex say --reply-to MSG_ID "…"
node --import tsx testing/shared-workspace/agents-live/participant.ts claude wait
```

`say` shows a typing signal before it sends the message. To let Codex CLI take part
on its own, run `codex exec` with network access in its sandbox and stdin closed
(`</dev/null`); otherwise it waits for stdin input.

## Record and cut

Start the observer before the first message. It opens one native console per
participant, only watches, and saves a frame when the render changes:

```sh
TMPDIR=/private/tmp cargo test --locked --manifest-path desktop/Cargo.toml \
  --test agents_live_recording -- --ignored --nocapture
```

Write `browser`, `conversation` or `stop` to `test-results/agents-live/control`
to switch views or finish. `render.py` turns the captures into
`artifacts/shared-workspace/agents-live/claude-codex-multiplayer.mp4`. It needs Pillow
and `ffmpeg`. Its beat table names source frame ranges, so retime it after a new
recording; `--preview` saves one still per beat. The edit only crops, holds and
speeds up native renders. Its end card states what is real and what is
demo-only.
