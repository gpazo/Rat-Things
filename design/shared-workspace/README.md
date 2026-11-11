# Multiplayer design studies

A focused workflow for reviewing an artifact while the same agent and team keep
working in one Session. The study uses Rat Things tokens, mark, participant
colors and existing product concepts.

```sh
cd design/shared-workspace
npm ci
npm run dev
```

Open http://127.0.0.1:4177. **Watch the flow** plays once; **Replay** starts it
again. **Try it yourself** lets you change the sample contributor, capture a page,
place a point or region, write feedback, reply, cancel a reply, resolve the
thread, and switch artifacts. Each artifact keeps its own draft. **Viewer access**
shows the reading experience. These are sample interactions without authentication,
network requests, a real browser connection or model inference.

The compact phone framing is a design study for a narrow presentation, not a new
iOS client. The native desktop console implements a narrow-window Work/Discussion
layout. The native console keeps its existing controls and services; this study
is not an embedded web replacement for it.

## Session conversation

Open `http://127.0.0.1:4177/?scene=session` for the conversation study.
Watch Sam reply to Eli while the agent continues, or choose **Try it yourself**
to compose as Sam, cancel a quote without losing the draft, inspect Activity,
and try Viewer access. The fixture illustrates one exchange; repeated sends
replace its sample contribution. The workspace button links to the artifact study.

The native conversation uses author badges, neutral message text, quoted context,
and a bounded composer. Progress comes from the saved Turn status. **Activity**
opens recent saved observations; **Details** contains runtime and raw status.
Both studies use the existing role model and fixed Session capabilities.

## Workflow

- Keep work next to discussion. Conversation and artifact feedback feed one agent.
- Distinguish the shared live browser from a saved capture. A numbered pin and its
  discussion refer to the same evidence.
- Keep the composer available while messages scroll. Navigation preserves drafts.
- Use a consistent identity color alongside the person's name. Color does not
  imply permission, and contributor history is not an online-presence claim.
- Continue using space roles and the Session's fixed capabilities.

The native implementation is in `desktop/src/app/artifacts.rs`; the shared
conversation renderer is in `desktop/src/app/conversation.rs`. User instructions are in
`docs/collaboration.md`. The native implementation supports the real browser,
immutable artifacts, annotation receipts, permissions and activity streams.

## Rehearse and capture

Use a dedicated headless Chromium binary; do not reuse a personal browser profile.
Set `CHROME_PATH` to that binary, then:

```sh
npm run build
node scripts/check-workspace.mjs
node scripts/check-session.mjs
node scripts/film.mjs 'http://127.0.0.1:4177/?capture=workspace' --gate
node scripts/film.mjs 'http://127.0.0.1:4177/?capture=workspace' --width 390 --gate
node scripts/film.mjs 'http://127.0.0.1:4177/?capture=workspace' --states --gate
node scripts/capture-workspace.mjs
```

The capture script writes under `artifacts/shared-workspace/design`. To encode its
movie frames, run ffmpeg from that output directory:

```sh
ffmpeg -y -f concat -safe 0 -i movie-frames.txt -vf fps=30 -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart workspace-design.mp4
```

For conversation captures, use `?capture=session` with the same film flags and
`node scripts/capture-session.mjs`. Its outputs go to `artifacts/session-design`;
encode them with the same ffmpeg command using `session-design.mp4` as the output.

The kit and filming tools are copied from stageshow under the accompanying
license. The ai-chat, presence and panel-annotation examples are kept as rehearsal
references. See the `REHEARSAL.md` beside each study for inspection limits.
