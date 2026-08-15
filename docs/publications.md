# Publications: files, sites, and video

Publications turn files retained by a successful Rat Things run into browser-ready, time-bounded
experiences. The same mechanism supports a single image, a static site with many assets, or a video
and poster without making the artifact bucket public or depending on a Lambda credential remaining
valid for the lifetime of the link.

## The model

The implementation deliberately has three small concepts:

- A **blob** is immutable bytes plus a digest, size, and media type. Storage coordinates stay inside
  the S3 adapter.
- A **publication** is an immutable directory with a required `index.html`, a manifest, provenance,
  and one of the tagged kinds `file`, `site`, or `video`. Its ready manifest lives under a reserved
  internal prefix that the edge router never serves.
- A **share grant** authorizes a particular publication until an explicit expiry. Today the grant is
  an unguessable bearer token; the contract leaves room for owner, team, or public policies later.

The flow is:

```text
.rat-things/artifacts/ catalog
              |
              v
  file / site / video builder
              |
              v
 immutable publication objects -- manifest committed last
              |
              v
 random bearer grant -- browser landing -- CloudFront signed cookies
              |
              v
 isolated publication subdomain -- private S3 through OAC
```

Publication builders are pure planning components. They return a typed result with diagnostics;
only the publication service performs storage effects. Builders are selected through a duplicate-
rejecting registry, and rendering is separate from storage and delivery. These choices borrow the
cleanest ideas from [Pi](https://github.com/earendil-works/pi): tagged data over implicit modes,
`Result` values for expected failures, small registries instead of a central switch, diagnostics as
data, and an “effects at the edge” orchestration layer. Rat Things does not copy Pi's extension API;
it keeps the surface narrow around the publication capability.

## CLI

Every source path is relative to `.rat-things/artifacts/` in the selected run or thread.

```bash
# A browser page for an image, PDF, audio file, or download
rat-things publish file images/rat-thing.webp --thread snow-crash

# A complete static directory; web/index.html is the entrypoint
rat-things publish site web --thread snow-crash

# A video player with an optional poster image
rat-things publish video video/chase.mp4 \
  --poster video/chase-poster.webp \
  --title "The Deliverator chase" \
  --thread snow-crash
```

Use `--run RUN_ID` for one-shot work and `--json` for the publication ID, kind, expiry, entrypoint,
primary downloadable path, and published paths. `rat-things files` is a read-only catalog listing;
`rat-things file PATH` mints a browser link, while `--download LOCAL_PATH` retrieves the original
bytes rather than the generated viewer page.

## Control API

Create publications with an IAM-authenticated request to either owner-scoped source:

```http
POST /v1/conversations/{conversationId}/publications
POST /v1/runs/{runId}/publications
Content-Type: application/json

{"version":"1","kind":"file","path":"images/rat-thing.webp","title":"Rat Thing"}
```

Site and video requests use the same versioned tagged shape:

```json
{"version":"1","kind":"site","root":"web","entrypoint":"index.html"}
{"version":"1","kind":"video","path":"video/chase.mp4","poster":"video/poster.webp"}
```

The response URL is on a publication-specific host. Its `/__share/{token}` route validates the
encrypted S3 share record and returns a short browser landing page with host-only signed cookies.
The cookies are delivered as protected response headers and, for clients that lose cookies while
following redirects, repeated by the landing page before it opens `/`. All relative site assets
then work naturally beneath the same origin for the full grant lifetime.

## AWS setup

Publication delivery is opt-in because CloudFront custom-domain resources require deployment-owned
DNS and key material. Configure:

```hcl
enable_publication_delivery         = true
publication_base_domain             = "agent-content.example"
publication_certificate_arn         = "arn:aws:acm:us-east-1:111122223333:certificate/..."
publication_public_key_pem          = <<-PEM
  -----BEGIN PUBLIC KEY-----
  ...
  -----END PUBLIC KEY-----
PEM
publication_private_key_secret_arn  = "arn:aws:secretsmanager:us-west-2:111122223333:secret:agent/publication-key-..."
publication_route53_zone_id         = "Z0123456789EXAMPLE"
```

Use a separate registrable user-content domain, not a subdomain or sibling of the application's
cookie domain; this prevents broad application cookies from reaching generated sites. The ACM
certificate must cover the wildcard (for example `*.agent-content.example`) and be issued in
`us-east-1`, as required by CloudFront. Store the matching RSA private key only in Secrets Manager.
Supplying the optional Route 53 zone lets the module create wildcard A and AAAA aliases; otherwise
create equivalent DNS records with the external provider.

The module creates one distribution, not one distribution per publication. A CloudFront Function
maps the validated publication host to its owner-scoped S3 prefix. Origin Access Control keeps S3
private, and a trusted key group enforces the signed cookies. Each publication receives a distinct
browser origin and host-only cookie jar, preventing one generated site from reading another
publication's content.

The supplied response policy allows local inline scripts and styles needed by static agent output,
but blocks cross-origin resource and API connections, framing, objects, forms, referrers, and
sensitive browser capabilities. Deployments that need external APIs should expose an explicit
policy profile rather than weakening every publication.

## Adding another output kind

Add a new member to the versioned `PublicationSpec` tagged union and implement one
`PublicationBuilder`. A builder receives catalog blobs and returns the publication directory it
wants; it does not import AWS clients, mint URLs, or write objects. Register it at composition time,
then add focused planning tests. Blob persistence, manifest-last commit, share grants, CloudFront
delivery, and CLI cookie handling remain unchanged.

Current retained-artifact limits are 5,000 files, 5 GiB per file, 20 GiB per catalog, and 512 UTF-8
bytes per relative path. Transfers are streamed with multipart S3 uploads. Unchanged retained files
are renewed with server-side copies, avoiding a full network re-upload on every conversation turn.
