# Native Rat Things worker proof

This opt-in Apple silicon experiment runs the real Rat Things worker and official Codex
executor inside a Linux VM created by Apple's Virtualization framework. It uses
the same `LocalRuntime` port, Session service, environment relay and remote file
protocol as the container path. The production runtime factory does not select
this adapter.

## Prepare and run

Use an Apple silicon Mac with Xcode, Python 3, an APFS checkout and the local
ARM64 worker image from `npm run runtime:local:build`. Allow at least 1 GiB of
free disk for preparation. Admission requires at least 8 GiB of host memory and
reserves the greater of 4 GiB or half of physical memory for host applications.
The worker uses one virtual CPU and 2 GiB of guest memory, with one native VM
allowed at a time across workers, snapshots and readiness probes. Critical or
unknown host memory pressure keeps new work queued. The worker proof accepts
only `RAT_NATIVE_PROOF_CPUS=1`; a two-CPU request fails before VM preparation.

```sh
npm run runtime:native:prepare
npm run test:e2e:native-worker
npm run test:e2e:native-reliability -- --runs 6 --cpus 1
```

Preparation uses a disposable container on a local Unix socket. It resolves the
source image to its content ID, adds filesystem and kernel-module utilities,
streams a `newc` archive with hard links preserved, and removes the container.
Set `RAT_NATIVE_SOURCE_IMAGE` to an explicit local image ID to select another
source. The package inventory and artifact hashes are recorded in
`.runtime/local-vm-worker/manifest.json`. Subsequent preparation reuses the base
archive and APFS clones it before appending the current worker and supervisor.

The resulting VM runs without a container engine. The smoke harness uses a
host-side fixture model; it does not read your login credentials or contact a
model service. Each run retains a `proof-*` directory with serial logs, a
workspace disk and, after all assertions pass, `result.json`. These directories
contain fixture Session data and can be removed when you no longer need the
evidence. Remove `.runtime/local-vm-worker/` to discard all prepared proof assets.

The reliability command runs complete fixture journeys sequentially and stops at
the first failure. It accepts 1–20 runs and defaults to one CPU; `--cpus 1` is the
only accepted CPU setting. Its `reliability-*`
directory records each proof path, logs, image hashes and host memory/architecture.
Each successful journey includes worker startup, graceful restart and a read-only
snapshot boot. Serial logs include full kernel boot output; an Oops panics the
guest without restarting, preserving the first fault for diagnosis.

## Boundary and lifecycle

The VM has no network adapter or shared host folders. A loopback listener on the
Mac forwards bytes through vsock to the existing authenticated relay. Relay
bearer credentials, expiring connection tickets and end-to-end Noise remain in
use. A separate bounded stdin/control-vsock channel configures the trusted guest
supervisor; it exposes only ping, health, worker start, snapshot and stop operations.
Configuration and relay credentials are not written to serial logs or boot files.

The real executor runs as UID/GID 10001. Model inference stays in the host
harness, where the normal local path uses the ChatGPT subscription flow. The
guest receives scoped relay credentials, never a model billing key or host
subscription token.

Before mounting devices, init moves a bind mount of its RAM root onto `/` and
changes root through the retained working directory. This gives user namespaces
and the existing Codex sandbox a normal root mount for their root pivots. It must
not delete the old root's files: both mounts refer to the same filesystem.

Only an exclusively created workspace disk may be formatted. A durable binding
records the Session generation, device/inode and filesystem UUID. The helper pins
and locks the admitted disk before attaching it. A missing or replaced prepared
disk cannot be silently allocated or adopted. Guest setup records its started and
complete phases in a root-private journal; an interrupted setup is retained and
cannot be replayed by a retry.

Worker health requires a bounded response from Node and its registered executor.
Freezing either process makes readiness fail. Lifecycle operations serialize per
Session, and shutdown drains pending operations before stopping remaining workers.
Recorded `controlReadyMs` measures guest supervisor readiness; it excludes worker
setup and executor registration.
Shutdown stops the worker, syncs and unmounts its filesystem before stopping the
VM. Snapshot creates another VM with the workspace block device attached
read-only and runs the existing bounded exporter as UID 10001. Export rejects an
ext4 filesystem that needs journal recovery; resume the workspace normally before
requesting another snapshot after an abrupt VM stop.

The shared smoke test checks real remote command output, isolated identity,
absence of host credentials/paths/sockets, disabled command networking, file
protocol access, persistence after graceful restart, setup running once and a
read-only snapshot. The ordinary test suite checks hard-link preservation and
shutdown error handling without booting a VM.

Run the separately opted-in fault suite after preparing the current image:

```sh
RAT_NATIVE_VM_FAULTS=1 node --import tsx testing/local-runtime/native-vm/worker/faults.ts
```

It creates an isolated copy of the prepared assets with a test-only fault-control
overlay. That overlay can freeze or kill the executor and supervisor; it is never
added to the normal image. The suite also kills the VM and controller, races
lifecycle requests, replaces/removes disks, and interrupts setup. Its `faults-*`
directory retains progress, serial logs and a final result only after all assertions
pass. No inference or subscription credentials are used.

## Remaining release work

This is a development proof, not an installer. Its ad-hoc signed helper and
Alpine 3.24.2 / Linux 6.18.52 fixtures are not yet a Rat Things guest distribution.
The package inventory is recorded, but repository packages are not yet supplied
through a reproducible locked image build. The RAM-backed root is also larger
than a production immutable root disk should be.

Earlier two-CPU development runs encountered intermittent guest kernel faults.
Their cause is unresolved, so the managed worker proof rejects two CPUs. The raw
helper remains available for separate fault investigation; it does not widen the
managed runtime's one-CPU policy. A passing repeat run does not explain those faults or
establish reliability under memory pressure, concurrent Sessions or abrupt power
loss. A maintained guest image must pass workload and recovery acceptance before
this runtime can be selected by default.

Before selecting native execution by default, add a maintained versioned image,
signed/notarized distribution, installation and update recovery,
host-pressure acceptance, sleep/wake acceptance, and repeat
acceptance of the real subscription sign-in/Turn journey. The existing AWS deployment and
idle Session-copy flow remain separate from this runtime proof.

The helper, bridge and supervisor are Rat Things code; this slice copies no Cua code.
The build records Linux fixture sources and hashes. Any distributed guest will
also need its complete license notices and corresponding source obligations.
