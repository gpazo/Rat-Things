# Durable files and Session Artifacts

The standard Files API stores uploaded input. Session Artifacts retain immutable
output from completed managed-environment Turns. Both belong to the authenticated
owner and keep content in encrypted S3.

## Uploaded input

```bash
rat-things files create --file input.pdf --purpose user_data
rat-things files list
rat-things files get file_example
rat-things files content file_example --output input-copy.pdf
```

Use the returned File ID in a standard environment file declaration. Environment
setup pins its input bytes so later deletion or replacement of an uploaded File
does not alter an already prepared environment. The Files API is separate from
listing a live environment's filesystem.

## Retained output

Managed Session environments snapshot regular files beneath `/workspace/outputs`
when a Turn completes. A saved artifact has its own ID, Session ID, Turn ID,
original environment path and size. Subsequent Turns may save new versions of
the same path. The service supports 200 MiB per artifact and 500 MiB per snapshot.

```bash
rat-things sessions artifacts sess_example
rat-things sessions artifacts sess_example art_example
rat-things sessions artifact-content sess_example art_example --output report.pdf
rat-things sessions artifact-delete sess_example art_example
```

Downloads use authenticated API content routes. Saved artifacts survive
execution-environment expiry. Deleting an artifact removes its API access without
deleting the original uploaded File or live environment file. A `self_hosted`
environment does not automatically publish its live files as Session Artifacts.

Write deliverables with clear names, verify their contents, and keep tool access
within the Agent's declared capabilities. Filesystem writes and browser/rendering
tools require an environment and the appropriate declared tools.

## Sharing

Creating a publication is a separate explicit action. Select saved artifact IDs
and relative publication paths, then mint an expiring bearer link through the
control endpoint. See [publish and share agent work](sharing-work.md). Uploading
or saving an artifact alone does not make it public.
