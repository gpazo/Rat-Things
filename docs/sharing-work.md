# Publish and share agent work

Create a publication from saved Session Artifacts to give recipients an expiring
link to a file, static site or video. Publication delivery must be configured on
the deployment; see [Publications](publications.md#aws-setup).

## Select retained output

Ask an Agent with a managed environment and the required tools to save deliverables
beneath `/workspace/outputs`. After its Turn completes, list the saved artifacts:

```bash
rat-things sessions artifacts sess_example
rat-things sessions artifact-content sess_example art_example --output report.pdf
```

The artifact ID selects immutable bytes from a specific Turn. Two Turns may
produce the same path with different artifact IDs. Select the version you intend
to share; a live environment path alone is not a publication source.

## Publish a file, site or video

Save a request as `publication.json`. This example publishes a static site:

```json
{
  "publication": {
    "version": "1",
    "kind": "site",
    "entrypoint": "index.html",
    "title": "Project report"
  },
  "files": [
    {"artifact_id": "art_index", "path": "index.html"},
    {"artifact_id": "art_css", "path": "styles.css"}
  ]
}
```

For a single file, set `publication` to
`{"version":"1","kind":"file","path":"report.pdf"}` and select that artifact
as `report.pdf`. For video, use `kind: "video"`, the video `path`, and an optional
`poster` path with its own selected artifact. Paths are relative, unique and
preserve the site's directory structure.

Set `RAT_THINGS_API_URL` to the deployment's control endpoint, then publish:

```bash
rat-things publications create --session sess_example --file publication.json
```

The JSON response includes the publication ID, kind, paths, expiry and share URL.
Publishing the same selection reuses the immutable publication and creates a fresh
grant. The service verifies Session ownership and every artifact before reading
or copying content.

## Send one link

Share the complete URL returned by the service, including `/__share/<token>`.
It is a bearer credential: anyone holding it can access that publication until
expiry. Redemption installs signed access for the isolated publication origin;
S3 remains private. Keep the token out of public logs.

Open the returned link and check the intended file, relative site assets, or
video playback before delivering it. Static sites must contain their own assets;
the publication response policy blocks external resources and API connections.

Grant expiry ends access through that grant. Retention of the publication bytes
is independent of the live environment and source artifact. Create a fresh grant
from an available source when another access window is needed.
