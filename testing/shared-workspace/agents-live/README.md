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
  RAT_AGENTS_LIVE_MODEL=gpt-5.6-luna node --import tsx testing/shared-workspace/agents-live/server.ts
```

The server accepts contributions only for the demo Session. Messages, input events
and annotation feedback are rejected once observed usage reaches
`RAT_AGENTS_LIVE_MAX_TURNS` Turns (default 6). Work already accepted can finish after
that threshold. The server stops after `RAT_AGENTS_LIVE_MAX_MINUTES` (default 45).
On shutdown it writes per-Turn token usage and cleanup outcomes to
`artifacts/shared-workspace/agents-live/cleanup.json`. If cleanup fails, the process
exits with an error and records which resources could not be removed. The demo
profile and its sign-in remain available for the next run.

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
