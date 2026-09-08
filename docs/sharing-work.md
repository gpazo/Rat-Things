# Publish and share agent work

Publish retained agent work as a file page, static site, or streamable video. Each publication has
an isolated, expiring share link.

## Choose the experience you want to deliver

| Output | Use it for | Command |
| --- | --- | --- |
| File | One image, PDF, audio file, report, archive, or download | `rat-things publish file PATH` |
| Site | HTML with local CSS, JavaScript, images, and other relative assets | `rat-things publish site ROOT` |
| Video | An MP4 or supported browser video with an optional poster | `rat-things publish video PATH` |

## Ask the agent to create and share

```bash
rat-things handoff --thread launch-demo --sandbox workspace-write \
  "Create an interactive launch demo as a self-contained website and share it with me."
```

With publication delivery enabled, the runner validates and publishes the agent's declared files
after a successful turn, then appends the share link to the reply. Connected chat and source-control
threads receive that link through their normal result delivery.

Use the commands below when you want to inspect retained work, republish an older result, select a
different root or poster, or drive the flow from structured automation.

## The retained output contract

Save deliverables beneath `.rat-things/artifacts/` before the Run completes. All publication paths
are relative to that directory; see [durable files](durable-files.md) for limits and retention.

Do not put credentials, private keys, session cookies, provider tokens, or other secrets in that
directory.

After the run, inspect the catalog rather than guessing filenames:

```bash
rat-things files --thread launch-demo
```

For automatic sharing, the agent writes the [publication declaration](publications.md#conversational-publishing)
to `.rat-things/share.json`.

The examples below select a conversation with `--thread`; use `--run RUN_ID` for one-shot work.
Add `--json` for the publication ID, kind, expiry, entrypoint, primary downloadable path, and
published paths.

## Publish a file

```bash
rat-things publish file launch-report.pdf \
  --thread launch-demo \
  --title "Launch readiness report"
```

`rat-things file` also creates a browser link:

```bash
rat-things file launch-report.pdf --thread launch-demo
```

Add `--download LOCAL_PATH` to `rat-things file` to retrieve the original bytes.

## Publish a static site

The root must contain an entrypoint, normally `index.html`:

```bash
rat-things publish site demo-site \
  --thread launch-demo \
  --entrypoint index.html \
  --title "Launch demo"
```

Build a self-contained site:

- use relative URLs such as `styles.css`, `images/overview.webp`, and `./app.js`;
- include every required asset beneath the published root;
- do not depend on a development server, server-side routes, or runtime environment variables;
- bundle the scripts, fonts, and data required for the core experience;
- open the output through its share link before claiming the site is complete.

The [publication response policy](publications.md#aws-setup) blocks external resources and API
connections, forms, framing, and sensitive browser capabilities.

## Publish a video

```bash
rat-things publish video demo-video/walkthrough.mp4 \
  --poster demo-video/poster.webp \
  --title "Launch walkthrough" \
  --thread launch-demo
```

Prefer an MP4 encoded for ordinary browsers and keep the poster reasonably small. The viewer uses
authenticated byte-range delivery so playback can start without downloading the whole object.

## Send one link

The command returns a link ready to paste into a pull request, message, email, or handoff:

```text
https://<publication-host>/__share/<grant-token>
```

Share the complete URL. The browser's Share command also preserves authorization for the remaining
grant lifetime; a shortened hostname copied from a mobile address bar does not.

The complete URL is a time-bounded bearer grant:

- send it only to intended recipients;
- do not place it in public logs or permanent source files;
- report its expiry alongside it; and
- mint a new link rather than trying to repair an expired signature.

## Links expire; the work endures

The default grant lifetime is 24 hours. Expiry closes that route into the publication; it does not
immediately delete the retained source file. While the owner and retained artifact still exist, the
owner can mint a fresh publication link.

## Deliver with proof

An agent that creates shareable work should perform the relevant checks and report them. The runner
performs publication and URL creation after the agent exits, so browser validation may be completed
by the caller or by a later agent turn:

1. Confirm the expected catalog paths and select the correct kind and smallest required root.
2. Open the complete `/__share/` URL in a fresh browser context.
3. Check site assets and interactions, video playback and byte ranges, or downloaded file bytes
   against the recorded SHA-256, as applicable.
4. Return the share URL, expiry, publication kind, primary retained path, and verification results.

## Recover quickly

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `Missing Key-Pair-Id` | A bare publication hostname or an incomplete older link was shared | Use the original complete `/__share/<token>` URL or mint a fresh link |
| `AccessDenied` / `Request has expired` | The bearer grant or an authenticated download URL expired | Ask the owner to mint a new link |
| Site HTML loads but assets fail | Absolute paths, missing retained files, or blocked external dependencies | Use relative paths, republish the complete root, and remove undeclared network dependencies |
| Video downloads instead of playing | Unsupported media type or encoding | Produce a browser-compatible MP4 and republish as `video` |
| Publication returns not found | The token was revoked, expired, malformed, or its share record is gone | Create a new publication grant from the retained source |
| CLI download returns HTML | The client predates publication redemption support | Update Rat Things and retry the canonical link |

For the implementation and security model, continue with [Publications](publications.md), [Durable
files and share links](durable-files.md), and the [Security and threat model](security.md).
