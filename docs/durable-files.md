# Durable files and share links

Rat Things lets an agent return screenshots, images, video, PDFs, reports, logs, and other
deliverables—not only text. Treat storage, private inspection, and external sharing as three
separate decisions:

1. **Retain the file.** The agent writes below `.rat-things/artifacts/`; trusted orchestration
   validates the bytes and commits them to the owner-scoped durable catalog after a successful turn.
2. **Inspect or download it privately.** An authenticated owner can list the catalog and open file
   content through the conversation console or owner-checked API routes.
3. **Share it externally.** Explicitly create an expiring bearer publication. `rat-things file` is
   the single-file convenience path; `rat-things publish file|site|video` chooses a richer viewer.
   Continue with [Publish and share agent work](sharing-work.md) before sending a link.

The MicroVM never receives an S3 credential for sharing. Trusted orchestration creates the
publication and mints its time-bounded bearer grant only after the file has been retained.

## Simple image demo

This example assumes the configured agent has an image-producing tool. The durable-file mechanism
does not depend on which browser, renderer, or image model creates the bytes.

```bash
rat-things handoff --thread pelican-demo --sandbox workspace-write \
  "Create an image of a pelican riding a bicycle. Save the final WebP as \
  .rat-things/artifacts/pelican-bicycle.webp, verify that it is non-empty, and mention the \
  relative filename in your reply."

rat-things files --thread pelican-demo
rat-things file pelican-bicycle.webp --thread pelican-demo
```

The successful chat command also prints links for files created or changed by that turn. The final
`file` command is useful when a person needs a fresh link later. Output looks like this; the values
are placeholders, not a live artifact:

```text
pelican-bicycle.webp  https://<publication>.<share-domain>/__share/<token>
```

Open that URL in a browser or download the bytes explicitly:

```bash
rat-things file pelican-bicycle.webp \
  --thread pelican-demo \
  --download ./pelican-bicycle.webp
```

Reuse the thread to continue working with the same file. Rat Things restores the committed catalog
before the next turn, including on a replacement MicroVM:

```bash
rat-things handoff --thread pelican-demo --sandbox workspace-write \
  "Open .rat-things/artifacts/pelican-bicycle.webp, make a second 512px variant, and save it as \
  .rat-things/artifacts/pelican-bicycle-512.webp."
```

Artifact transport and durability are built into Rat Things. Browser control, image generation,
and video rendering are tools supplied to the agent separately; any such tool can publish through
the same directory contract.

## Instructions for an agent running inside Rat Things

Treat `.rat-things/artifacts/` as a managed, durable working directory:

1. Write every user-visible deliverable below `.rat-things/artifacts/` using a clear relative name,
   such as `screenshots/login.png`, `reports/audit.pdf`, or `video/demo.mp4`.
2. Create parent directories when needed. Publish regular files only; symbolic links, hard links,
   devices, sockets, traversal, absolute paths, and control characters are rejected.
3. Verify the deliverable before completing the turn. At minimum, confirm that it exists and is not
   empty. When correctness matters, also check its format, dimensions, duration, or SHA-256 digest.
4. Keep a file in the directory if the conversation should retain it. Remove it when the user wants
   it removed from the next committed catalog. A failed or interrupted turn cannot replace the last
   successfully committed catalog.
5. Mention each relevant relative filename in the final response. Do not paste binary data or a
   large base64 payload into the response when a file will do.
6. Never place credentials, tokens, cookies, private keys, or other secrets in this directory. A
   later authorized caller can mint a bearer URL for any cataloged file.

Rat Things injects this contract into managed agent prompts. A successful turn causes trusted runner
code to inspect the directory, hash each file, upload immutable bytes under an owner-scoped
`blobs/sha256/<digest>` key, and commit the current path catalog. The directory is a VM-local staging
view restored from that catalog before each turn, so generated output does not create high-churn S3
Files writes. The agent does not upload to S3 or create share links itself.

## Instructions for a supervising agent or automation

Use a stable thread name for work that may continue. Use a stable idempotency key when retrying the
same semantic request. Keep JSON on stdout and progress on stderr:

```bash
THREAD_ID=pelican-demo
TURN_ID=asset-request-001

rat-things chat \
  --thread "$THREAD_ID" \
  --idempotency-key "$TURN_ID" \
  --sandbox workspace-write \
  --json \
  "Create the requested image and save it below .rat-things/artifacts/." \
  > turn.json

rat-things files --thread "$THREAD_ID" --json > files.json
rat-things file pelican-bicycle.webp \
  --thread "$THREAD_ID" \
  --json > file.json
```

The file-list response contains safe metadata—ID, relative path, media type, byte count, creation
time, source run, and SHA-256—but no S3 bucket or object key. The single-file response adds `url` and
`expiresAt`. Select by exact relative path or catalog ID; a basename works only when unique.

For asynchronous supervisors, add `--no-wait` to `chat`, persist its receipt, and poll the returned
message with the control API. Do not request files until the message is `consumed`, its run is
`succeeded`, the conversation is `idle`, and the MicroVM session is `suspended`. For a one-shot run,
replace `--thread THREAD_ID` on the file commands with `--run RUN_ID`.

Recommended automation behavior:

- verify `bytes`, `mediaType`, and `sha256` before forwarding a result;
- treat `url` as a secret until `expiresAt` and avoid placing it in durable logs;
- mint a new URL with `rat-things file` instead of caching an expired URL;
- download to a controlled path with `--download` when another tool needs local bytes; and
- retain the thread name and file path when asking the agent to revise an existing deliverable.

Run `rat-things help --all` for the complete headless surface.

## Durability and access lifetime

Files are private, content-addressed S3 objects under owner-hashed prefixes. Conversation metadata
holds a bounded path catalog, and a later turn restores those exact bytes into fresh local staging
before Codex starts. The default object retention is 30 days and is configured independently from
the MicroVM lifetime.

With publication delivery enabled, `rat-things file` creates an opaque bearer URL valid for 24 hours
by default. The public endpoint validates its encrypted grant, opens a signed browser-ready first
page, and installs host-only CloudFront cookies for its subresources. Generated file and video
viewers also carry the signed authorization into their asset requests. Deployments without that
optional custom domain return a direct one-minute S3 download URL from the authenticated control
API. Publication grant lifetime is configured through `artifact_url_ttl_seconds` from 60 through
86,400 seconds. A new link can be minted while the owner and retained artifact still exist.

The initial catalog limits are:

- 5,000 files;
- 5 GiB per file;
- 20 GiB across the directory;
- 8 MiB for the JSON catalog; and
- 512 UTF-8 bytes per relative path.

Transfers are streamed and unchanged retained objects are renewed with S3 server-side copies.
Identical bytes share one owner-scoped content key even when catalog paths differ. Common image,
audio, video, PDF, text, web-font, manifest, and WebAssembly formats receive browser-correct media
types; unknown formats are downloads. See [publications](publications.md) for multi-file sites, video
players, AWS setup, and the extension model.

## What the live proof established

On 2026-08-14, a real Codex turn ran headlessly in a freshly deployed Rat Things Lambda MicroVM and
wrote `pelican-bicycle.webp` below the managed directory. The runner published 31,286 bytes, the
conversation reached `idle`, and the MicroVM suspended. A separate CLI invocation minted a 24-hour
share URL; following its redirect downloaded the exact bytes with SHA-256
`2ee07cbbdc885a7c6f5bfa30b484aa3198356fe9b960683a31b1bf486ea62058`. The public link and S3
redirect used the replacement Rat Things stack; the legacy test stack was then destroyed.

This proves the headless MicroVM-to-private-storage-to-recipient-browser path and resumable catalog
contract. Agent computer use is a separate Chromium dynamic-tool path with its own security and
validation status; see [architecture](architecture.md) and [status](status-and-roadmap.md).

See [the control API](api.md#durable-files), [conversation durability](conversations.md), and the
[security model](security.md) for lower-level contracts and production caveats.
