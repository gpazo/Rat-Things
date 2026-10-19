# Durable files and Session Artifacts

The standard Files API stores uploaded input. Session Artifacts retain immutable
output from terminal managed-environment Turns. Both belong to the authenticated
owner and keep content in encrypted S3.

## Uploaded input

```bash
rat-things files create --file input.pdf --purpose user_data
rat-things files list
rat-things files get file_example
rat-things files content file_example --output input-copy.pdf
```

Use the returned File ID in a standard environment file declaration. Environment
setup pins its input bytes so later deletion of the uploaded File
does not alter an already prepared environment. The Files API is separate from
listing a live environment's filesystem. Uploads allow up to 512 MiB, but each File
used as an environment input must fit within 50 MiB. Inline environment files allow
5 MiB each and 10 MiB together.

## Retained output

Managed Session environments snapshot regular files beneath `/workspace/outputs`
when a Turn completes, fails or is cancelled, provided the worker can capture its
output. Abrupt worker loss cannot guarantee a final snapshot. A saved artifact has
its own ID, Session ID, Turn ID, original environment path and size. Subsequent Turns
may save new versions of the same path. The service supports 200 MiB per artifact
and 500 MiB per snapshot.

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

Retained bytes are subject to the deployment's S3 lifecycle policy. The reference
module's `artifact_retention_days` defaults to 30 days and applies to uploaded Files,
Session Artifacts and publications. API deletion removes access; it does not promise
immediate physical erasure of versioned storage. Keep a separate copy when work must
outlive that retention window.

Write deliverables with clear names, verify their contents, and keep tool access
within the Agent's declared capabilities. Writing files inside a managed workspace
requires a managed environment. Browser and rendering capabilities come from declared
tools; a remote function or service-origin MCP tool can operate without that workspace.

## Sharing

Creating a publication is a separate explicit action. Select saved artifact IDs
and relative publication paths, then mint an expiring bearer link through the
control endpoint. See [publish and share agent work](sharing-work.md). Uploading
or saving an artifact alone does not make it public.
