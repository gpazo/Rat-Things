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

## Conversational publishing

When publication delivery is enabled, the agent can request sharing by writing deliverables beneath
`.rat-things/artifacts/` and an ephemeral outbox at `.rat-things/share.json`. The runner processes
the outbox after a successful turn:

```json
{
  "version": "1",
  "publications": [
    {
      "version": "1",
      "kind": "site",
      "root": "web",
      "entrypoint": "index.html",
      "title": "The Deliverator chase"
    }
  ]
}
```

The outbox is cleared before every turn, capped at ten requests and 32 KiB, and rejected if it is a
symbolic link, hard link, or malformed document. It is a declaration rather than authority: the
trusted runner resolves every path through the authenticated owner's catalog, performs publication,
mints the grant, and appends the real link to the stored result. Bearer URLs remain in encrypted S3
result bodies rather than DynamoDB previews. The outbox is cleared after consumption and never
replayed.

The publication ID derives from the normalized spec, selected paths, content digests, and media
types. Its manifest is committed last. Sharing unchanged work reuses the committed publication and
mints a fresh grant; changed bytes or presentation options produce a new publication ID.

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
```

```json
{"version":"1","kind":"video","path":"video/chase.mp4","poster":"video/poster.webp"}
```

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
