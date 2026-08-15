# Share agent work safely

Rat Things can turn retained agent output into a browser-ready file, static site, or video player.
This guide is the practical contract for people requesting work, agents producing it, and tools
that need to pass a share link to someone else.

## Choose the smallest publication that fits

| Output | Use it for | Command |
| --- | --- | --- |
| File | One image, PDF, audio file, report, archive, or download | `rat-things publish file PATH` |
| Site | HTML with local CSS, JavaScript, images, and other relative assets | `rat-things publish site ROOT` |
| Video | An MP4 or supported browser video with an optional poster | `rat-things publish video PATH` |

A file publication is usually the right default. Choose a site only when the output needs multiple
coordinated assets or interaction. Choose a video publication when range requests and a dedicated
player matter.

## The agent output contract

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

Static sites run on an isolated publication hostname. Keep them portable and deliberately boring:

- use relative URLs such as `styles.css`, `images/overview.webp`, and `./app.js`;
- include every required asset beneath the published root;
- do not depend on a development server, server-side routes, or runtime environment variables;
- do not assume external scripts, fonts, APIs, forms, cameras, microphones, or payments are
  available; and
- open the output through its share link before claiming the site is complete.

The default publication policy blocks surprise cross-origin access. A future policy profile may
allow explicit external dependencies, but weakening every generated site is not the default.

## Publish a video

```bash
rat-things publish video demo-video/walkthrough.mp4 \
  --poster demo-video/poster.webp \
  --title "Launch walkthrough" \
  --thread launch-demo
```

Prefer an MP4 encoded for ordinary browsers and keep the poster reasonably small. The viewer uses
authenticated byte-range delivery so playback can start without downloading the whole object.

## Share the canonical link

The command returns a bearer URL shaped like this:

```text
https://<publication-host>/__share/<grant-token>
```

Share that complete URL. The `/__share/<grant-token>` portion is the credential exchange. After a
browser opens it, the address bar may show only the publication hostname; that shorter address is
not a reusable share link and will return a CloudFront `Missing Key-Pair-Id` error in a fresh
browser.

Treat the complete URL like a time-bounded password:

- send it only to intended recipients;
- do not place it in public logs or permanent source files;
- report its expiry alongside it; and
- mint a new link rather than trying to repair an expired signature.

## Expiry and durability are different

The default grant lifetime is 24 hours. Expiry closes that route into the publication; it does not
immediately delete the retained source file. While the owner and retained artifact still exist, the
owner can mint a fresh publication link.

This separation avoids links whose advertised lifetime is secretly shortened by rotating Lambda
credentials. Publication access uses deployment-owned CloudFront signing material, while original
bytes remain in encrypted private S3.

## Validate before handing off

An agent that creates shareable work should perform the relevant checks and report them:

1. List the retained catalog and confirm every expected path appears.
2. Publish the correct kind using the smallest root that contains the work.
3. Open the complete `/__share/` URL in a fresh browser context.
4. For sites, load each local asset and exercise the main interaction.
5. For video, confirm playback starts and the asset supports byte ranges.
6. For exact files, download the original bytes and compare the recorded SHA-256 when available.
7. Return the canonical share URL, expiry, publication kind, and primary retained path.

Do not report only “uploaded successfully.” The useful handoff is evidence that a recipient can
open the work through the same link they will receive.

## Diagnose common failures

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `Missing Key-Pair-Id` | The bare publication hostname or an incomplete link was shared | Use the original complete `/__share/<token>` URL or mint a fresh one |
| `AccessDenied` / `Request has expired` | The bearer grant or a legacy S3 redirect expired | Ask the owner to mint a new link |
| Site HTML loads but assets fail | Absolute paths, missing retained files, or blocked external dependencies | Use relative paths, republish the complete root, and remove undeclared network dependencies |
| Video downloads instead of playing | Unsupported media type or encoding | Produce a browser-compatible MP4 and republish as `video` |
| Publication returns not found | The token was revoked, expired, malformed, or its share record is gone | Create a new publication grant from the retained source |
| CLI download returns HTML | The client predates browser landing support | Update Rat Things and retry the canonical link |

For the implementation and security model, continue with [Publications](publications.md), [Durable
files and share links](durable-files.md), and the [Security and threat model](security.md).
