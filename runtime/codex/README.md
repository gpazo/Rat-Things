# Maintain the Codex runtime

Rat Things uses the official, unmodified Codex 0.164.0 release. It does not compile
Codex, apply source patches or rewrite its executable. Runtime-specific behavior
belongs in Rat Things adapters and uses the public Codex app-server protocol.

## Release identity

[source.json](source.json) records the upstream repository, release commit and
version. [companion-packages.json](companion-packages.json) records the official
npm package URL, integrity, descriptor and every runtime file hash for each
supported platform. [package-lock.json](../../package-lock.json) pins the same
packages. The entrypoint, code-mode and voice companions, shared libraries,
resources and bundled `bwrap` must all match that inventory. Bundling voice
resources does not enable voice.

The [packager](../../scripts/build-codex-runtime.mjs) copies the installed official
package into a new directory and writes `artifact.json` beside `runtime/`. It
then runs the [validator](../../scripts/codex-runtime-artifact.mjs). Validation
requires the pinned distribution identity and exact bytes for every file,
including `bin/codex`; a self-consistent manifest cannot authorize a modified
binary. Missing or extra files, symlinks, unsupported targets and old custom-build
manifests are rejected. The original package descriptor is preserved.

Linux packages use the upstream musl targets. Worker and VM helper target names
are separate from the Codex distribution target. Linux ARM64 remains required
for Lambda packaging; Linux x64 is used by the local KVM development backend.

```sh
npm ci
npm run codex:build -- /absolute/path/to/new-runtime
```

The historical `codex:build` command packages the official release for the host
platform; it performs no Rust compilation. Use a new output directory. To prepare
a different Linux architecture, use the container packager:

```sh
docker buildx build --platform linux/arm64 --file runtime/codex/Dockerfile \
  --output type=local,dest=/absolute/path/to/new-arm64-runtime .
```

Keep `artifact.json` and `runtime/` together. Select an export with
`CODEX_RUNTIME_ARTIFACT`. Installing a newer global `codex` does not update Rat
Things' pinned worker artifact.

## Adapter contracts

Codex settings follow the capabilities exposed by the pinned release. Rat Things
maps its public settings at the boundary and rejects unsupported explicit choices
before starting model work. Provider failures retain the precision available in
Codex's public typed events; private diagnostic text is not used to invent error
categories or returned as a public message.

Sandbox enforcement remains a prerequisite for managed execution. On Linux,
network-disabled execution uses a validated proxy policy with no allowed
destinations so Node subprocess I/O can work without granting external network
access. The host owns the effective policy and refuses unexpected configuration
or approval requests. Tests must verify actual denied writes and connections,
not infer enforcement from a configuration flag.

Native checkpoint publication requires completed-turn recovery verification by
the host. An ordinary Codex process exit is not a persistence acknowledgement.
The host must stop all writers, synchronize storage, and verify the saved native
root and child identities and complete public history in a disposable isolated
process before publishing a candidate. Verification must not perform model work
or tools, and its writes must not replace the saved candidate. Running commands,
pending interactions and arbitrary background work are not migrated. Failed
verification must fail the handoff; it must not silently reconstruct a prompt or
start a new native thread. The opt-in AWS checkpoint harness remains necessary
before claiming cloud worker replacement acceptance.

The cold verifier supports the built-in OpenAI and Amazon Bedrock providers and
custom Responses API providers. It rejects Ollama and LM Studio before stopping
the live process because their recovery paths are unsupported; ordinary Sessions
and Pi Durable execution are unaffected.

## Upgrade and rollback

1. Preserve the previous artifact and matching repository revision. Select an
   official stable release and inspect its public protocol, sandbox behavior and
   companion layout.
2. Update the source pin and npm lock together. Verify each official package's
   tarball integrity before refreshing the complete inventory. Update model
   defaults from that release's catalog; absent models keep a null default.
3. Package into a new directory and verify its complete inventory. Update Rat
   Things adapters for upstream changes. Do not patch Codex to preserve an old
   assertion or substitute an unrelated executable.
4. Run the strict native contracts, sandbox and checkpoint regressions against
   those exact official bytes. Then run `npm run check`, worker-image checks and
   relevant managed acceptance harnesses described in [testing](../../testing/README.md).
5. Record the release, artifact identities, validation and limitations in the PR.
   Promote the release only after the required gates pass.

CI packages official ARM64 and x64 releases and exports them after their required
gates. Cached artifacts still undergo validation and behavior checks. The macOS
CI job validates the desktop; it does not establish signed runtime acceptance.
The native macOS bundle assembler preserves every official Codex and companion
byte, including existing signatures. It signs only the Rat Things VM helper and
outer bundle, then checks the official payload hashes again. Native macOS runtime
distribution remains blocked: admission of the upstream signatures still requires
design and validation on a Mac. The existing installer signer checks remain in
force, and assembled candidates retain `distributionReady: false`.

Rollback must move the source definition, package lock, inventories, adapters and
runtime artifact together. Preserve newer session storage and verify that the
older version can read it before admitting a rollback. Never bypass checksum,
sandbox or checkpoint verification to make an older artifact run.
