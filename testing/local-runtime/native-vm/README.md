# Native Linux boot proof

Run on an Apple silicon Mac with Xcode:

```sh
node testing/local-runtime/native-vm/smoke.mjs
```

This opt-in experiment builds a small Swift helper, applies an ad-hoc local
Virtualization entitlement, downloads two digest-pinned Alpine 3.22.0 ARM64
fixtures and boots a Linux initramfs without Docker. It uses no model account,
network device, host folder share or cloud resources. It does not alter your
existing runtime selection.

The guest writes a nonce to a newly created 16 MiB sparse disk. The harness kills
its helper process and starts another VM with the same disk. The second guest
must read that nonce and shut down. A success report requires both guest markers;
starting a VM alone is insufficient. Each boot has a 30-second deadline. The
guest gets two CPUs and 256 MiB of RAM. The script requires 512 MiB of free disk
space and caps each download at 32 MiB.

Artifacts live under `.runtime/local-vm-prototype/`. Each run has separate disk,
serial logs, configuration and `result.json` files. These are test artifacts;
they contain no subscription credentials. Remove this directory when the proof
is no longer needed. Repeating the test retains old proof directories for review.

The fixture kernel is packaged as a Linux EFI zboot image. The harness verifies
its pinned digest, reads its gzip payload and passes the uncompressed ARM64 Image
to `VZLinuxBootLoader`. The appended initramfs runs only the fixed disk probe.
These old, networkless fixtures are not a production guest distribution.

## What remains unproven

This proves native Linux boot and recovery of a synced raw disk marker after
the VM process dies. It does not prove filesystem crash consistency, Session
recovery, executor isolation, subscription inference, virtual-socket transport,
snapshots or production resource defaults. Assigned guest memory is not measured
host memory overhead.

The separate [real-worker proof](worker/README.md) extends this experiment with
private vsock transport, the existing executor, persistent filesystem storage and
the shared Session smoke harness. Its evidence and limitations are separate from
this raw-marker test.

The production provider still needs an authenticated virtual-socket bridge to
the existing relay, a reproducible versioned image containing the real Node/Codex
executor, immutable workspace-disk identity, installation/recovery state, and a
signed distributable helper. Keep subscription sign-in and inference on the host.

References: [Apple Linux boot loader](https://developer.apple.com/documentation/virtualization/vzlinuxbootloader),
[Alpine fixture source](https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/netboot-3.22.0/).
The helper is new Rat Things code; it does not copy Cua source.
