# Linear live AWS demo launch kit

These assets document the August 30, 2026 live proof against a private Linear workspace. The issue
content is intentionally synthetic. No credential screen or token value appears in the package.

## X post

Linear is live in Rat Things. A Codex agent in an AWS Lambda MicroVM created IND-6, updated it,
commented, and read it back—5/5 bounded tool calls succeeded. The model never saw the OAuth token.
Read-only follow-up: search + get only.

Attach `assets/linear-live-aws-e2e.mp4`.

## X thread follow-up

The receipt: teams.list → issues.create → issues.update → comments.create → issues.get. Every call
settled durably. Then we reused the same installed account under a read-only capability envelope;
creation disappeared and no write call was recorded.

## Website copy

### Keep the backlog moving—without leaving the conversation.

Ask Rat Things to find the right team, check for existing work, create the issue, sharpen the
description, and leave the handoff note. It returns the Linear link to the same thread, so the
decision and the work stay connected. Use it from Slack, a scheduled Routine, your own product, or
the CLI—with the Linear workspace and actions chosen for each workflow.

## Alt text

### Video

Forty-second screen recording showing Linear OAuth consent, a healthy Rat Things Connection,
a live AWS conversation with five successful Linear tool calls, the real IND-6 issue and app-authored
comment, and a closing receipt stating that five calls succeeded and no credentials were exposed.

### Provider screenshot

Dark-mode Linear issue IND-6 titled “Rat Things ↔ Linear live AWS proof,” with a description stating
that the model received typed tools but never the OAuth token, plus a Rat Things app-authored live
AWS E2E proof comment.

### Durable receipt screenshot

Rat Things console showing the completed live Linear conversation, the IND-6 URL, and five settled
tool calls: teams list, issue create, issue update, comment create, and issue get.

## Asset manifest

- `assets/linear-live-aws-e2e.mp4` — 1280×720 H.264, 39.4 seconds, no audio; primary share video.
- `assets/linear-live-title.png` — 1280×720 poster and social thumbnail.
- `assets/linear-marketing-poster.png` — product-led website video poster.
- `assets/linear-live-issue.png` — real Linear provider result.
- `assets/linear-live-write-run.png` — write/read-back Run and five-call receipt.
- `assets/linear-live-read-only.png` — narrowed read-only follow-up.
- `assets/linear-live-connection.png` — healthy installed Connection.
- `assets/linear-live-connection-details.png` — verified provider identity and authority details.
- `assets/linear-live-oauth-consent.png` — Linear consent screen.
- `assets/linear-live-oauth-installed.png` — successful AWS OAuth callback.
- `assets/linear-live-homepage.png` — rendered homepage Linear marketing section with the embedded video.
