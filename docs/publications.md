# Publications: files, sites, and video

Publications give retained files, static sites, and videos expiring browser access while S3 stays
private. This page covers the contract and deployment; use [publish and share agent work](sharing-work.md)
for CLI commands and recipient checks.

## The model

- A **blob** is immutable bytes plus a digest, size, and media type. Storage coordinates stay inside
  the S3 adapter.
- A **publication** is an immutable directory with a required `index.html`, a manifest, provenance,
  and one of the tagged kinds `file`, `site`, or `video`. Its ready manifest lives under a reserved
  internal prefix that the edge router never serves.
- A **share grant** is an unguessable bearer token authorizing one publication until an explicit
  expiry.

## Session artifact publishing

Managed environments retain regular files beneath `/workspace/outputs` as
immutable Session Artifacts after completed Turns. Select saved artifact IDs
explicitly when publishing. The owner-checked source resolver verifies the whole
selection before reading content or writing a publication; artifact IDs from
another owner, another Session, or deleted artifacts are rejected.

The publication ID derives from the Session, normalized specification, selected
paths, content digests and media types. Its manifest is committed last. Repeating
the same selection reuses the publication and mints a fresh grant. Its provenance
records the Session and artifact IDs. A publication remains available independently
of the live environment and its source artifact's subsequent deletion, subject to
the publication retention policy and grant expiry.

## Control API

Use the IAM-authenticated control endpoint, separate from the standard Agents API:

```http
POST /v1/sessions/{sessionId}/publications
Content-Type: application/json

{
  "publication": {"version":"1","kind":"site","entrypoint":"index.html"},
  "files": [
    {"artifact_id":"art_index","path":"index.html"},
    {"artifact_id":"art_style","path":"style.css"}
  ]
}
```

Each artifact ID and relative path must be unique. Paths cannot contain traversal,
absolute paths or backslashes. `file` specifications select `path`; `video`
specifications select `path` and an optional `poster`; `site` specifications select
an optional `root` and `entrypoint`. Only the selected saved bytes are available to
the builder. The agent's live filesystem does not grant publication access.

The response URL is on a publication-specific host. Its `/__share/{token}` route validates the
encrypted S3 share record and redirects to a cryptographically signed first-page URL while also
installing host-only signed cookies. The first page therefore opens even when a browser delays or
drops cookies from the redirect. CloudFront repeats the cookies on that successful page response,
and generated file and video viewers also carry the signed authorization into their asset requests.
Relative site assets then work naturally beneath the same isolated origin for the grant lifetime.

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

One CloudFront distribution maps validated publication hosts to owner-scoped S3 prefixes. Origin
Access Control keeps S3 private, and a trusted key group enforces the signed URLs and cookies.
Distinct browser origins and cookie jars prevent one generated site from reading another
publication's content.

The supplied response policy allows local inline scripts and styles needed by static agent output,
but blocks cross-origin resource and API connections, framing, objects, forms, referrers, and
sensitive browser capabilities.

## Adding another output kind

Add a new member to the versioned `PublicationSpec` tagged union and implement one
`PublicationBuilder`. A builder receives catalog blobs and returns a directory plan or diagnostics;
it does not import AWS clients, mint URLs, or write objects. Register it at composition time and add
focused planning tests. The publication service owns storage and delivery.

See [durable files](durable-files.md) for artifact limits, retention, and transfer behavior.
