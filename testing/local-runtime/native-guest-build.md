# Build a maintained native guest

Build the Linux ARM64 Codex release artifact first. The artifact must match the
source definition, patched tree policy, and complete companion inventory accepted
by `scripts/codex-runtime-artifact.mjs`.

Capture an initial package candidate into a new directory outside `dist`.

```sh
node scripts/build-native-guest.mjs record-candidate \
  --guest-artifact /absolute/path/to/linux-artifact \
  --output /absolute/path/to/new-candidate \
  --source-date-epoch 1792627200
```

Use `--definition-root /absolute/path/to/runtime/codex` when the checked source
definition is staged separately. That directory must include `source.json`, the
ordered patches, and `artifact-policy.json`. Use `--kernel-input-directory PATH`
to supply `vmlinuz-virt` and `modloop-virt` explicitly. Their locked checksums still
apply. Otherwise the builder downloads the two URLs in
`runtime/native/kernel-inputs.json`.

Review `candidate-lock.json` against `observed-inputs.json` and `evidence/`.
Check the ARM64 base manifest and config digests, complete before/after RPM
inventories, source RPM identities, licenses, repository metadata, imported key
fingerprints, and cached RPM checksums and signature results. The repository
release alone does not establish an exact package lock. Resolve any differences
before preserving a reviewed copy with `status` set to `checked`. The builder
does not perform that promotion.

Build from the checked lock into another new directory.

```sh
node scripts/build-native-guest.mjs build \
  --guest-artifact /absolute/path/to/linux-artifact \
  --lock /absolute/path/to/checked-lock.json \
  --output /absolute/path/to/new-checked-build \
  --source-date-epoch 1792627200
```

Both commands build `native-root` through the default builder on a local Docker
Unix socket. They export a fresh container created from the exact new image ID.
The archive process has no container network. Output includes `Image`,
`worker-initramfs.gz`, the archive inventory, worker dependency and build records,
package evidence, the build log, and `guest-build.json`. Failed builds retain
`failed-build.json` and any evidence already written. Neither command signs a
bundle or starts a VM.

The archive retains guest links, file modes, ownership, and device metadata. It
uses the supplied source epoch for file timestamps and zero for the gzip header
timestamp. Initial console and null devices are present before devtmpfs mounts.
Container hostname, hosts, resolver, and machine-ID files are empty. Logs, caches,
build tools, build evidence, root account state, private Codex state, and workspace
contents are excluded. Limits are 100,000 entries, 1,400 MiB before compression,
and 600 MiB after compression.

Run a second independent build from the same checked inputs before assessing byte
reproducibility. Compare both kernel and initramfs bytes, then use the archive
inventories to inspect differences. RPM database contents can still differ.
`guest-build.json` leaves reproducibility unestablished. Corresponding source,
complete notices, signed assembly, and installed acceptance remain distribution
requirements.

Run the ordinary fixture checks without Docker.

```sh
npx vitest run tests/scripts/native-guest-inputs.test.ts tests/simulation/native-vm-prototype.test.ts --pool=forks --maxWorkers=1 --isolate
```
