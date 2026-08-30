# Publish and share agent work

Turn anything an agent makes into an experience someone else can open: a polished file page, a
complete static site, or a streamable video. Rat Things keeps the source with the durable project
and gives each publication its own isolated, time-bounded share link.

## Choose the experience you want to deliver

| Output | Use it for | Command |
| --- | --- | --- |
| File | One image, PDF, audio file, report, archive, or download | `rat-things publish file PATH` |
| Site | HTML with local CSS, JavaScript, images, and other relative assets | `rat-things publish site ROOT` |
| Video | An MP4 or supported browser video with an optional poster | `rat-things publish video PATH` |

A file publication is the fastest route from artifact to audience. Use a site for an interactive or
multi-asset experience, and use a video publication when fast streaming and a dedicated player
matter.

## Ask the agent to create and share

The normal human workflow is a conversation, not a publishing pipeline:

```bash
rat-things --thread launch-demo --sandbox workspace-write \
  "Create an interactive launch demo as a self-contained website and share it with me."
```

The agent creates the retained files and declares the publication it wants. After the turn, trusted
orchestration validates those paths, builds the publication, creates an expiring grant, and appends
the canonical link to the agent's reply. The same mechanism works when the request comes from a
connected chat or source-control thread, so the link returns to the place where the user is already
talking with the agent.

Use the commands below when you want to inspect retained work, republish an older result, select a
different root or poster, or drive the flow from structured automation.

## The retained output contract

An agent must save every deliverable beneath `.rat-things/artifacts/` before its run completes.
Nested paths are retained, so group related work in a directory:

```text
.rat-things/artifacts/
  launch-report.pdf
  demo-site/
    index.html
    styles.css
    app.js
    images/
      overview.webp
  demo-video/
    walkthrough.mp4
    poster.webp
```

Do not put credentials, private keys, session cookies, provider tokens, or other secrets in that
directory. Retained output is private by default, but it is deliberately designed to become
shareable.

After the run, inspect the catalog rather than guessing filenames:

```bash
rat-things files --thread launch-demo
```

When asked to share during the turn, the agent also writes a bounded declaration to
`.rat-things/share.json`. It contains only publication kinds and paths relative to the retained
catalog. It contains no storage coordinates, credentials, or precomputed URLs.

## Publish a file

```bash
rat-things publish file launch-report.pdf \
  --thread launch-demo \
  --title "Launch readiness report"
```

For the common case where you already know the retained file path, `rat-things file` also creates a
browser link:

```bash
rat-things file launch-report.pdf --thread launch-demo
```

Use `--download LOCAL_PATH` when another tool needs the original bytes instead of a browser page.
The client verifies the owner-scoped artifact and follows the publication grant without scraping
the viewer.

## Publish a static site

The root must contain an entrypoint, normally `index.html`:

```bash
rat-things publish site demo-site \
  --thread launch-demo \
  --entrypoint index.html \
  --title "Launch demo"
```

Static sites run on their own isolated publication hostname. Build them as portable, self-contained
experiences:

- use relative URLs such as `styles.css`, `images/overview.webp`, and `./app.js`;
- include every required asset beneath the published root;
- do not depend on a development server, server-side routes, or runtime environment variables;
- bundle the scripts, fonts, and data required for the core experience;
- treat server APIs, forms, cameras, microphones, and payments as explicit future policy choices;
- open the output through its share link before claiming the site is complete.

The default policy favors work that opens consistently without hidden dependencies. Future policy
profiles can add explicit external services without weakening every generated publication.

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

Share that complete URL. The `/__share/<grant-token>` portion is the credential exchange. The
browser then keeps a signed first-page URL in its address bar, so using the browser's Share command
also produces a reusable link for the remainder of the grant lifetime. The visually shortened
hostname shown by some mobile address bars is not the full link.

The complete URL is a time-bounded bearer grant:

- send it only to intended recipients;
- do not place it in public logs or permanent source files;
- report its expiry alongside it; and
- mint a new link rather than trying to repair an expired signature.

## Links expire; the work endures

The default grant lifetime is 24 hours. Expiry closes that route into the publication; it does not
immediately delete the retained source file. While the owner and retained artifact still exist, the
owner can mint a fresh publication link.

This separation avoids links whose advertised lifetime is secretly shortened by rotating Lambda
credentials. Publication access uses deployment-owned CloudFront signing material, while original
bytes remain in encrypted private S3.

## Deliver with proof

An agent that creates shareable work should perform the relevant checks and report them. The runner
performs publication and URL creation after the agent exits, so browser validation may be completed
by the caller or by a later agent turn:

1. List the retained catalog and confirm every expected path appears.
2. Declare the correct kind using the smallest root that contains the work.
3. Open the complete `/__share/` URL in a fresh browser context.
4. For sites, load each local asset and exercise the main interaction.
5. For video, confirm playback starts and the asset supports byte ranges.
6. For exact files, download the original bytes and compare the recorded SHA-256 when available.
7. Return the canonical share URL, expiry, publication kind, and primary retained path.

A strong handoff includes the canonical link, expiry, publication kind, primary retained path, and
the evidence that a recipient can open it.

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
