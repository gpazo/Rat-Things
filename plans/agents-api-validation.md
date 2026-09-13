# Current migration validation

The local release gates are complete. The migration is ready to start isolated
live AWS acceptance. This is not a claim of 100% deployed compatibility; the
remaining behavior and deployment acceptance rows are in
[`agents-api-conformance.md`](agents-api-conformance.md).

## Accepted local evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Full `npm run check` | Passed: 822 tests, 10 opt-in skips; architecture/schema/route checks, TypeScript, packaged Lambda smoke, site build and all three Terraform configurations | `/tmp/rat-readiness-check-complete.log` |
| Strict Linux ARM64 native suite | 148 passed across 27 files, no skips, UID 10001 in the worker image | `/tmp/rat-native-linux-final-2.log` |
| Strict patched macOS suite | 148 passed; the final seven changed probe/schema checks also passed | `/tmp/rat-native-macos-current.log`, `/tmp/rat-network-tests-macos.log` |
| Final ARM64 worker image | Trusted runner/guest environment isolation; lifecycle-port denial; external port 8080 allowed; Chromium interaction, screenshots, private-address denial and valid VP8 WebM recording | `/tmp/rat-worker-image-final.log` |
| Final ARM64 HTTP/relay image | Unprivileged health, discovery, authentication and pinned protocol-client checks passed | `/tmp/rat-relay-image-final.log` |
| Terraform mocked-provider cases | EC2-only and both-backend S3 Files configurations passed with Terraform 1.15.8; no AWS calls | `/tmp/rat-infra-gate.log` |
| LocalStack 4.14.0 | Four canonical workflows passed, including provisioning; disposable resources removed | `/tmp/rat-readiness-localstack.log` |
| Local CLI and console | Offline smoke passed; two console cases passed, one live AWS case skipped | `/tmp/rat-local-smoke-current.log`, `/tmp/rat-readiness-console.log` |
| Website browsers | 28 passed; final overview/guide changes additionally passed three entry-point cases | `/tmp/rat-site-browser-current.log`, `/tmp/rat-site-overview-final.log` |

The final repository check used two Vitest workers on this 8 GiB host, the patched
macOS harness, the accepted Linux package and Terraform 1.15.8. `dist/` contains the
packaged Lambdas and worker build context. `git diff --check` passes.

## Accepted native artifact and images

- Codex version: `0.154.0`.
- Upstream source: `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`.
- Patches: `release-lock.patch` and `interrupt-barrier.patch`; exact digests are in
  `runtime/codex/` and the artifact manifest.
- Audited patched tree: `0a503469b8b86050e41f1a33320864a3a5935098`.
- Compiler target: `aarch64-unknown-linux-gnu`; locked release build, debug off,
  incremental off, one Cargo job.
- Native binary SHA-256:
  `c63820e7d5f6c94b2f6c273e2fa0d6bb55170c20e175426a10b338ffa3f2d8ea`.
- Workspace artifact: `.runtime/codex/linux-arm64`. Default-path verification
  accepts all six runtime files plus the manifest, with no environment override.
- Worker image `rat-things-microvm-e2e:local`:
  `sha256:69d8b303c0a3111de242ade827e2808b80dce61d54b51577c7d29be317bd8bb9`.
- HTTP/relay image `rat-things-relay-e2e:local`:
  `sha256:b9f33baffc05dbb742069e1a4734851cc35cb322bb2943470bf35909cbaa957f`.
- Strict fixture image `rat-things-native-parity:local`:
  `sha256:4f28fa4558bfdd5eaf149f6bcad171e6fe0d9947afdac7f6bf4cf7e9e143bc0c`.

The cold Cargo build completed in 203 minutes 38 seconds. The audited re-export
reused the compilation cache and produced the same binary digest. Build logs are
`/tmp/rat-codex-arm64-build-2.log` and `/tmp/rat-codex-arm64-build-3.log`.
CI has a 240-minute budget and an explicit disk-space gate; its artifact cache key
uses the native source/patch/Dockerfile and builder inputs. GitHub Actions itself
has not run. Rust unit tests were not run; native behavior was exercised by the
strict protocol/integration fixtures on both architectures.

## Findings closed by final verification

- The interruption barrier passes ten successful interrupted follow-ups at each
  child limit (1 and 6), plus ten competing nested admissions. Exact capacity
  excludes the coordinator. Recovery retains saved facts without replaying tools
  or recreating children; code-mode and deferred function round trips pass.
- The first Linux suite found two malformed test-proxy requests and one schema
  cold-compilation timeout. Node's environment-aware global HTTP Agent had proxied
  an already-proxied request, causing a Host-header mismatch. The probes now use an
  explicit Agent and public numeric host, asserting HTTP 403 plus `not_allowed`
  rather than accepting a DNS/private-address rejection. The schema test has a
  bounded 15-second allowance. All 148 cases passed in the final image.
- The strict test image installs dependencies as UID 10001 and uses owned copies,
  removing the redundant recursive ownership layer. The worker image is unchanged
  by these test-only fixes.
- Canonical cloud Sessions explicitly select Codex. The deployment-wide mock
  driver and credential-check bypass are gone; explicit local mock use remains.
- EC2-only persistent storage grants the EC2 role and omits unused MicroVM network
  connectors. Both-backend storage retains both principals and the connector.
- Browser observation retries do not replay actions, and protocol deadlines bound
  dropped replies. The final production helper passed interaction and recording.

## Remaining live acceptance

Follow [`aws-live-readiness.md`](aws-live-readiness.md) for the isolated EC2-backed
AWS cycle. Prepared cases cover canonical API/console use, large binary Files,
the five-minute disconnected input deadline with concurrent SSE, managed commands,
artifacts, guest boundaries, idempotency and an eight-hour-plus process soak.
Provider, schedule, recovery, credential and webhook scenarios remain listed in
[`obsolete-implementation-removal.md`](obsolete-implementation-removal.md).

This local acceptance phase did not invoke AWS or external providers. The subsequent
authorized AWS deployment and live model evidence are tracked in
[`aws-live-validation.md`](aws-live-validation.md). No real provider messages have
been sent; webhook delivery uses the disposable deployment-owned capture endpoint.
No retained production data, deployment state or credentials were deleted. Only
superseded local test images and selected build outputs were removed for disk space;
the compiled native cache and accepted artifacts remain available.
