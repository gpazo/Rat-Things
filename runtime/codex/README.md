# Maintain the Codex runtime

Codex is the default runtime; Pi Durable is optional. This directory defines the
patched Codex executable and matching companions used by the worker and local
runtime builds. Treat an upstream upgrade as a behavior change, even when every
patch applies cleanly.

## What is pinned

[source.json](source.json) selects the upstream repository, exact commit, release
version and ordered patches. [companion-packages.json](companion-packages.json)
locks each platform's npm package identity, tarball integrity, descriptor and file
hashes against [package-lock.json](../../package-lock.json). The compiled executable
travels with its matching code-mode host, `rg`, `zsh` and Linux `bwrap` resources.
Replacing only `bin/codex` from an unrelated release is not an upgrade.

[artifact-policy.json](artifact-policy.json) binds the source and ordered patch
hashes to the reviewed patched Git tree. The [builder](../../scripts/build-codex-runtime.mjs)
checks the checkout before and after its locked release build. Its exported
`artifact.json` records that identity, target, build settings and complete file
inventory; keep it beside `runtime/`. The [validator](../../scripts/codex-runtime-artifact.mjs)
compares this evidence with repository policy and companion hashes, rather than
trusting an artifact's own claims. Artifact validation is not a signature or a
runtime behavior test.

## Why each patch exists

The order below is the application order in `source.json`. Rust test names refer
to tests in the patched upstream checkout; repository links identify separate
integration checks. Building the executable does not run those Rust tests.

| Patch | Contract to preserve | Existing regression evidence |
| --- | --- | --- |
| [release-lock.patch](release-lock.patch) | Align workspace package versions in `Cargo.lock` with the pinned release so `cargo build --locked` succeeds without rewriting the lock. | The locked build and exact-tree audit; no separate runtime behavior change. |
| [interrupt-barrier.patch](interrupt-barrier.patch) | Await child task interruption before acknowledging it, so a follow-up on that child does not race the previous execution guard at the concurrency limit. | Strict interruption/follow-up cases in [native-session.test.ts](../../tests/agents/native-session.test.ts), plus nested limit checks in [native-admission.test.ts](../../tests/agents/native-admission.test.ts). |
| [api-model-settings.patch](api-model-settings.patch) | Preserve explicit `auto`, `default`, `flex`, `priority` and `fast` service tiers through config and Turn updates; the provider decides support without a silent catalog/UI downgrade. | Patched config, Session and protocol service-tier unit tests; [native-session-settings.test.ts](../../tests/agents/native-session-settings.test.ts) checks outgoing requests across Turns. |
| [api-turn-errors.patch](api-turn-errors.patch) | Preserve typed provider failures across HTTP and SSE, including credit exhaustion and timeouts; keep private diagnostics out of normalized errors and credit exhaustion non-retryable. | Patched API bridge/SSE unit tests; [native-turn-errors.test.ts](../../tests/agents/native-turn-errors.test.ts) checks public categories, private-message removal and request count. |
| [checkpoint-shutdown.patch](checkpoint-shutdown.patch) | Add private `thread/checkpoint`: require an idle durable thread and acknowledge successful persistence shutdown, with a bounded wait. The host must seal admission first. | [session-checkpoint.test.ts](../../tests/runner/session-checkpoint.test.ts) checks orchestration with an RPC fixture. The opt-in [AWS checkpoint proof](../../tests/aws/session-checkpoint.test.ts) exercises actual worker replacement and native history; the fixture alone does not prove a durable flush. |
| [step-settings-test-import.patch](step-settings-test-import.patch) | Restore the `ServiceTier` import needed by the upstream step-settings tests after the settings patch removes the production import. | Compile and run the affected `codex-core` unit tests; this is a test-build fix. |
| [unified-exec-output-subscription.patch](unified-exec-output-subscription.patch) | Subscribe when the process output channel is created, retaining early output until the streaming consumer takes its receiver. | Patched Rust test `exit_watcher_preserves_output_emitted_before_streaming_starts` checks both streamed bytes and completed command output. |
| [chatgpt-service-tier.patch](chatgpt-service-tier.patch) | Omit `auto`/`default` for ChatGPT authentication while preserving other explicit tiers and API-key/Bedrock request values across HTTP, WebSocket and compaction requests. | Patched `responses_service_tier_*` Rust tests cover these transports/auth modes, including repeated Turns and WebSocket continuation. They use local fixtures, not a live provider. |

## Upgrade one candidate at a time

1. Preserve the last verified artifact and its matching repository revision before
   changing inputs. Review upstream changes to the patched contracts, sandbox,
   app-server protocol and companion layout. Record an upstream issue/PR when a
   patch is proposed there; do not assume an equivalent fix from its title alone.
2. Update the source pin and exact npm dependency/lockfile together. Rebase the
   ordered patches, review every changed hunk, and refresh companion inventories
   from the matching integrity-verified npm packages for all supported targets.
   Refresh [model-defaults.json](model-defaults.json) from the pinned upstream
   catalog and review [model-capabilities.json](model-capabilities.json) against
   actual API behavior. The builder verifies the defaults' source hash and values.
3. Use a new build directory for the candidate. Run `npm run codex:build --
   /absolute/path/to/new-build --prepare-only`, inspect the resulting source diff,
   and derive the expected patched tree from those reviewed inputs. Update
   `artifact-policy.json` with that tree and the source identity hash; never take
   the expected tree from an untrusted artifact merely to make validation pass.
4. Compile and run the affected upstream Rust test modules, including the tests
   named above. Then build and validate each platform below. Use the exact candidate
   executable for `CODEX_CONFORMANCE_BINARY`; keep strict parity enabled through
   `npm run test:agents:parity`. A fixture pass establishes the exercised protocol
   behavior, not live authentication or VM isolation.
5. Run `npm run check` with the matching ARM64 packaging artifact, the worker-image
   gates and the relevant local acceptance harnesses. Record artifact identities,
   commands, results and remaining gaps in the PR/evidence directory. Promote
   source policy and artifacts together only after the required gates pass.

Use the build commands and prerequisites in the
[native compatibility guide](../../testing/README.md#agents-api-native-compatibility-gate).
The [target map](../../scripts/codex-runtime-targets.mjs) is authoritative:

| Lane | Build and acceptance |
| --- | --- |
| Linux ARM64, `aarch64-unknown-linux-gnu` | Build `runtime/codex/Dockerfile` with `--platform linux/arm64` on the worker's Amazon Linux 2023 baseline. Run packaging, `test:e2e:native-image` and `test:e2e:microvm-image`. Lambda packaging remains ARM64. |
| Linux x64, `x86_64-unknown-linux-gnu` | Build the same Dockerfile with `--platform linux/amd64`. Validate the x64 artifact, run strict native parity and sandbox tests with it, then exercise the [KVM managed Session harnesses](../../testing/local-runtime/linux-kvm/README.md). Building an image does not prove isolation. |
| Apple silicon macOS, `aarch64-apple-darwin` | Build natively with `codex:build` and run strict native parity on macOS. Pair it with the matching ARM64 Linux guest; follow the [guest build](../../testing/local-runtime/native-guest-build.md), [signature fixtures](../../testing/local-runtime/native-signatures/README.md) and [installed runtime acceptance](../../testing/local-runtime/README.md). Keep the signed bundle/verifier contract intact. |

The [CI workflow](../../.github/workflows/ci.yml) builds and exports ARM64 and x64
artifacts after their configured gates. Downloaded exports still require provenance
validation. Its macOS job checks the desktop, not a patched macOS runtime release;
do not count that job as macOS runtime acceptance. Caches save compilation work and
never replace artifact validation or semantic tests. For checkpoint changes, include the
explicitly opted-in AWS checkpoint proof before claiming cloud handoff acceptance;
ordinary checks must not provision AWS resources.

## Upstream, drop or roll back

Prefer small upstream fixes with the reproducer attached. Drop a patch only when
the pinned upstream source implements the required contract without it, or Rat
Things deliberately removes that dependency. Remove it from `source.json`, refresh
the tree policy, and rerun its semantic regression and affected platform gates.
Keep the regression after dropping the patch. Build/test-only patches can go once
the clean upstream release builds and its affected tests compile without them.

If a candidate fails, retain the previous verified release. Roll back the source
definition, patches, lockfile, companion inventory and policy together, and select
their matching complete artifact and worker image or signed app release. Do not
relax validation or fall back to the stock npm binary. Check durable-state
compatibility before opening Sessions written by the newer candidate; preserve
their storage and withhold rollback admission if compatibility is unknown. Keep
the last verified artifact outside disposable build caches until its replacement
has passed acceptance.
