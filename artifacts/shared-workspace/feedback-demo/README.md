# Shared feedback and Plan demo

A 50-second walkthrough of three native Rat Things clients reviewing a product
direction in one Session. Maya selects the headline, Eli narrows the scope and Sam
raises an offline edge case. The agent-owned Plan connects their contributions to
its decisions and the saved direction document.

Play `multiplayer-workspace.mp4`. Captions are also in `multiplayer-workspace.srt`.

## What is real and what is scripted

The native ConsoleApp controls, local Session service, SQLite persistence, isolated
Linux worker, Chromium, typing, attribution, artifact captures, host Plan tool,
source references and saved artifact retrieval are real. Three authenticated
loopback clients use demo identities. This is headless rendering of native
components, not a recording of operating-system windows.

The Responses model is a local deterministic fixture. Agent replies and Plan
choices are scripted; direction.md is seeded fixture content. There are no paid
model calls. Timing is edited for readability and is not a latency measurement.
This recording does not repeat AWS or live-model validation.

## Evidence and reproduction

- `evidence.json`: native capture assertions, including all three clients, image
  delivery, four Plan revisions and exact source references.
- `activity.json`: resulting fixture conversation and Plan.
- `cleanup.json`: disposable local worker, paired volumes and profile removed.
- `recording.json`: source frame hashes and the edit timeline.
- `review/`: inspected full-size shots and storyboard.

The capture and renderer are documented in
`testing/shared-workspace/README.md`. `feedback-edit.json` binds the cut to the
source manifest; a new recording must be reviewed and retimed before export.
