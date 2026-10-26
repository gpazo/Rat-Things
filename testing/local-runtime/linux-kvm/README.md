# Linux KVM development worker

This harness prepares an opt-in x86-64 Linux worker for local verification. It is
an unsigned development image, not a production installer. The worker boots a
real Linux kernel under KVM with no network interface. Model inference and
credentials stay in the local service; agent effects run inside the VM.

The initramfs uses [ramfs](https://www.kernel.org/doc/html/latest/filesystems/ramfs-rootfs-initramfs.html)
so the complete toolchain can unpack beyond the default
half-RAM limit of `tmpfs`. Guest memory remains fixed at 2 GiB inside a 3 GiB host
cgroup; changing the root filesystem does not increase those limits.

Preparation requires an x86-64 Linux host, a local Docker Unix socket, Node.js,
Python, GNU tar with zstd support, `ldd`, `gpg`, `gpgv`, and the Arch Linux package signing
keyring at `/usr/share/pacman/keyrings/archlinux.gpg`. Running the worker also
requires usable `/dev/kvm`, `/dev/vhost-vsock`, a user systemd manager, and enough
memory for the runtime's admission checks. The preparation command does not
change host permissions or install host packages.

First package the official Linux x64 Codex artifact and local worker image using the
[contributor instructions](../../README.md). Set `DOCKER_HOST` to the local
engine socket and unset `DOCKER_CONTEXT` when selecting an endpoint explicitly.
Only the immutable image ID resolved at the start of preparation is used. Every
packaged Codex file must match the admitted x64 artifact before the builder starts.

Stage these development inputs before preparation:

- `vmlinuz-virt`, `modloop-virt` and `config-6.18.52-0-virt` from the exact URLs in
  [kernel-inputs.json](kernel-inputs.json). Their hashes are checked locally.
  These are HTTPS release inputs with pinned hashes, not signed release assets.
- QEMU x86 packages, firmware and library packages with detached `.sig` files.
  Supply a JSON array of `{ "path": "/absolute/package.pkg.tar.zst", "sha256":
  "..." }` records through `--qemu-evidence`. Every archive is hashed and its
  signature verified before extraction. The default evidence location is
  `test-results/local-pi-parity/qemu-packages.json`.

```bash
npm run runtime:linux-kvm:prepare -- \
  --artifact .runtime/codex/linux-x64 \
  --image docker.io/library/rat-things-local:1 \
  --kernel-inputs .runtime/linux-tools/kvm-proof \
  --qemu-evidence test-results/local-pi-parity/qemu-packages.json \
  --output .runtime/linux-kvm
```

The trusted builder installs guest filesystem tools from the pinned Amazon Linux
repository release, checks the matching kernel modules, and exports a normalized
initramfs. It runs no agent or model tools. QEMU's executable, modules, firmware,
loader and resolved libraries are copied into the output; symlinks become regular
files. Dependency checks reject missing libraries and resolutions outside the
copied tree. Additional host libraries used during preparation are recorded by
path and hash.

The command prints an immutable `image-...` directory beneath the output root.
It publishes that directory only after successful verification and refuses to
overwrite an existing generation. Keep `manifest.json`, `Image`,
`worker-initramfs.gz`, `rat-linux-worker` and `qemu/` together. The `evidence/`
directory retains the source snapshots, kernel inputs, package inventory, Codex
provenance, guest archive inventory and dependency hashes. Host asset directories
are private to the preparing user.

Select the printed directory explicitly, then run the real-worker acceptance
harnesses. Both use the actual default KVM runtime and preserve evidence in a
new `run-...` directory:

```bash
CODEX_BINARY=/absolute/path/to/official-artifact/runtime/bin/codex \
RAT_THINGS_LINUX_KVM_RUNTIME=/absolute/path/to/image-HASH \
  npx tsx testing/local-runtime/pi-parity.ts \
  --directory test-results/local-pi-parity

CODEX_BINARY=/absolute/path/to/official-artifact/runtime/bin/codex \
CODEX_RUNTIME_ARTIFACT=/absolute/path/to/official-artifact \
RAT_THINGS_LINUX_KVM_RUNTIME=/absolute/path/to/image-HASH \
  npx tsx testing/local-runtime/codex-parity.ts \
  --directory test-results/local-codex-parity
```

The Pi harness uses a deterministic fixture model. The Codex harness uses a
loopback Responses fixture and verifies the host executable against the official
artifact. Both exercise managed file and command effects, same-UID writes outside
the workspace, symlink escape denial, disabled command networking, cancellation
of command descendants, and a new Turn after restarting the local service. Pi
also restarts while waiting for a function result to check durable recovery.

The Codex harness then creates a separate asset generation with a broken bundled
sandbox executable. It requires both drivers to fail at the worker's setup
sandbox gate before any model request. The original assets are unchanged; the
altered initramfs, its hashes and the guest serial logs remain in the evidence
directory. This deliberately invalid generation is a test fixture and must not
be selected for ordinary work.

These checks fail if the worker cannot start. A successful image preparation
alone does not establish sandbox enforcement or Session recovery. Fixture
inference does not establish live model or desktop UI behavior.
