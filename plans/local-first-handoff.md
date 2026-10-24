# Local-first Rat Things: handoff plan

This is the working plan for making Rat Things usable indefinitely on a person's own computer, with
a near-seamless, still self-hosted path into their own AWS deployment. It was written for the
next agent picking up the work. Read `AGENTS.md`, `BRAND.md`, `docs/local-workspace.md` and this
file before changing anything.

## Accepted product direction

1. Rat Things provisions and manages its own local environment in the first public release. Install,
   choose this computer, connect a subscription and get a verifiable first result. No separately
   installed Docker Desktop, Colima or OrbStack, source checkout, compiler or Terraform is required
   for the ordinary local path. Existing engines remain an advanced/development option.
2. Upgrading to AWS is nearly seamless and stays self-hosted and open source: same API, CLI,
   SDK, Session concepts and desktop.
3. Model access: the user's own subscription for local use **and local development**, including
   prototypes and live integration validation. Codex/ChatGPT is first. No OpenAI API key setup or
   silent API-key fallback; a missing or expired login leads to subscription sign-in/recovery.
   Deterministic tests may use credential-free local fixtures. AWS uses Bedrock (or an explicit
   opt-in subscription bridge), configured separately from local development.
4. Codex/ChatGPT first, extensible later. Complete the Codex home-to-AWS journey before adding
   another harness. The owner identified `earendil-works/pi-durable-cloudflare` as the Pi Durable
   reference. This means the `@earendil-works/pi-durable` library, not the conventional pi coding
   agent invoked through `pi --mode rpc`. Review its architectural fit now; implement its adapter
   after the Codex journey. Subscription model access is required before a real local Pi prototype
   counts as working; an API-key-only prototype does not satisfy the milestone.
5. macOS, Linux and Windows are the platform roadmap. Validate Apple silicon first; each other
   platform needs its own managed provisioning path and the same end-to-end acceptance journey.
6. User and developer experience come first. The CLI and SDK are first-class, not only the desktop.

The owner explicitly chose **"Provision its own local environment"** and agreed with the reviewed
sequence: review the flows, finish local distribution, complete the AWS transition, prove the real
journey, then broaden capabilities and harnesses. This settles product ownership of provisioning;
it does not mean native distribution or the complete onboarding journey has shipped.

Keep local operation useful indefinitely. Cloud continuation is optional. It copies an idle
Session's history, configuration and workspace into a new destination Session; it does not migrate
running processes. Configure model access at the destination and review any model change.

## Managed environment architecture proposal

### Runtime implementation and flow review

The shared runtime boundary is implemented in `src/core/local-runtime-ports.ts` and
`src/app/local-runtime.ts`. Composition injects it into worker orchestration and
the private workspace status API; the CLI uses the same factory for doctor/setup.
The existing container adapter remains selected. Setup now rechecks the installed
runtime before reporting success. Runtime migration is not enabled by this change.

The clickable flow review is in `testing/local-runtime/flow-review/`. Start it with
`node testing/local-runtime/flow-review/serve.mjs`. It covers subscription onboarding,
local preparation, resource limits, progress/recovery and an idle Session copy into
AWS. It uses simulated state and has not replaced the native console. The owner
reviewed it, called it a huge improvement and asked to continue. This approves the
direction; installer and native-console implementation still need acceptance.

The opt-in `testing/local-runtime/native-vm/smoke.mjs` builds a Swift helper and
boots a small ARM64 Linux initramfs directly with Apple's Virtualization framework.
It verifies a raw disk marker survives killing the helper and booting a second VM
with that disk. There is no external engine, shared host folder, network adapter or
model call in this proof. This is boot/storage evidence, not a functioning Rat Things
executor or filesystem/Session crash-recovery guarantee.

The opt-in worker implementation is in `testing/local-runtime/native-vm/worker/`.
It adds a bounded stdin/control-vsock protocol, a loopback bridge to the existing
authenticated relay, the real Node/Codex worker, a persistent ext4 workspace and
a read-only snapshot VM. Image preparation reuses the existing ARM64 worker image
by content ID; Docker is a build-time dependency for this experiment. Execution
uses Apple's Virtualization framework directly. Its shared smoke harness uses
fixture inference while preserving the normal host-side ChatGPT subscription path.
The complete fixture proof passes command execution as UID 10001, sandbox
network denial, file access, graceful restart, setup once and a read-only snapshot.
The VM has no network adapter or shared host directory. This does not establish
live subscription acceptance, abrupt filesystem recovery or production reliability:
earlier intermittent two-CPU guest kernel faults remain unexplained despite
passing repeated two-CPU journeys on the current image.
See the worker README for commands and the current release limitations.

Next: establish a maintained guest image and resolve kernel reliability; bind
preparation receipts to immutable disk identity; then add verified resumable
installation and native-console integration. Keep these behind the runtime boundary
until they meet the existing isolation, readiness and stopped-writer snapshot
contracts. Shipping helper signing, release artifacts and the complete live
ChatGPT-subscription-to-AWS journey remain open.

The default `LocalContainerRuntime` still uses an existing local Docker-compatible engine.
`LocalManagedEnvironment`, the CLI and the workspace API now access the shared runtime
boundary through composition. The public Agents/Sessions/Turns API remains unchanged.

- Introduce an internal runtime port for status, installation progress, start, stop, running state,
  snapshot and shutdown. Compose the selected adapter in `src/app`; keep OS process execution in
  adapters and lifecycle policy in pure domain functions. Route desktop, CLI and SDK through the
  same service operations instead of separate setup scripts.
- First prototype: a bundled, narrowly scoped macOS helper using Apple's Virtualization.framework
  to boot a headless Linux ARM64 guest. Selectively port MIT Lume lifecycle/configuration code;
  retain the source revision and notices. Rat Things owns the helper and provisioning flow. No Cua
  account, CLI installation or service is required.
- Prototype a separate VM for each active Session, with a persistent workspace disk and a
  versioned boot image. Measure memory, startup and disk costs before fixing production defaults.
  A shared Rat Things VM is an alternative to evaluate, not permission to silently weaken Session
  isolation. OS backends may differ, but must report their actual isolation boundary.
- Keep Codex, its private home and subscription login on the host. Reuse the existing patched
  worker executor, UID separation and fixed capability envelope in the guest. Establish an
  authenticated host-to-guest transport, preferably a virtual socket exposed through a private
  host adapter; verify compatibility with the existing executor protocol in the prototype.
  No host folder shares, engine socket or model credentials enter the guest by default.
- Distribute a bootable guest image, kernel/firmware if needed, and the native helper as verified,
  versioned artifacts. The current OCI worker image is useful build input but is not a bootable
  VM disk. Build and test that image pipeline explicitly; do not substitute a first-run source build.
- Rat Things owns resource budgets, download/resume, image verification, startup/readiness, crash
  reconciliation, stop/restart, storage inspection, update rollback and uninstall. Image updates
  must retain Session disks and cannot mutate a running Session underneath an accepted Turn.
- Existing engine-backed workspace volumes need an explicit export/import path into managed
  Session disks. Retain the old volume until the imported workspace is verified. Do not assume
  that changing the selected runtime makes existing files appear in the new backend.
- Keep the worker runtime separate from the harness's persistence and wakeup needs. Pi Durable
  owns durable internal tasks and needs storage/ownership/wakeup adapters; treating it as only a
  child CLI process would lose the reason to use it. See workstream 7 before freezing these seams.
- Windows and Linux adapters are separate follow-up feasibility work. Do not promise identical
  hypervisors, zero OS prerequisite prompts, or supported status before testing on those hosts.

Inspected upstream source: Cua revision `864fd4e525fe14d55fda25502c69132505a0e85d`,
[`LinuxVM.swift`](https://github.com/trycua/cua/blob/864fd4e525fe14d55fda25502c69132505a0e85d/libs/lume/src/VM/LinuxVM.swift)
and [`VMVirtualizationService.swift`](https://github.com/trycua/cua/blob/864fd4e525fe14d55fda25502c69132505a0e85d/libs/lume/src/Virtualization/VMVirtualizationService.swift).
The inspected Lume code configures EFI boot and VM devices; Rat Things still needs its own unattended guest
image, readiness protocol and integration. Its pinned `Package.swift` targets macOS 14; verify the
actual deployment target of the selected subset rather than assuming the current documentation's
minimum. Cua's current [licensing map](https://github.com/trycua/cua/blob/main/legal/LICENSING.md)
distinguishes MIT runtime components from FSL Spaces components. Review the exact files at the
pinned revision for each future port. No new upstream code has been copied by this plan update.

## Working-tree warning

At handoff, `main` had a large **uncommitted** local-first change set (about 50 modified and 30
untracked files) made before this plan existed, plus the changes below. Nothing has been
committed. Do not reset, stash or reformat unrelated files. Ask the owner whether to commit the
existing work as a baseline before you begin.

## Already done in this handoff

| Change | Files |
|---|---|
| Cross-platform worker policy: Windows `npipe://` endpoints, Linux Docker Desktop, native Linux only with gVisor `runsc`, Podman refused, arch-aware `linux/arm64` / `linux/amd64` | `src/domain/local-runtime.ts` (`localEngineEndpoint`, `workerPlatform`, `localIsolation`) |
| Preview gate: platforms other than Apple silicon Macs report "in preview" unless `RAT_THINGS_PREVIEW_PLATFORMS=1` | `src/adapters/local-container-runtime.ts` (`localRuntimeStatus`) |
| Launches use the detected `--platform` and add `--runtime runsc` under gVisor (worker and snapshot) | `LocalContainerRuntime.adopt`, `runtimeArguments` |
| Worker image install without a checkout: digest-pinned published images in `runtime/local/images.json` (empty for now), pulled and re-tagged as `rat-things-local:1`; checkout build is the arm64 fallback | `planWorkerImageInstall`, `installPublishedWorkerImage`, `src/workspace-cli.ts` (`runtime setup`) |
| `LocalRuntimeStatus` now also reports `platform`, `isolation` and `install` (additive) | `src/domain/local-runtime.ts` |
| Harness port, separate from the model account: `HarnessId = 'codex' \| 'pi'`, `ModelAccount`, `LocalHarness` | `src/core/harness-ports.ts` |
| Codex moved behind the port; composition selects a harness and rejects `pi` until it exists | `src/runner/local-codex-harness.ts`, `src/app/local-composition.ts` |
| Account status is now `{ harness: 'codex', provider: 'chatgpt', … }` (`provider` was `'codex'`); `/v1/workspace` reports `harness` | `src/runner/local-subscription.ts`, `src/local-server.ts`, `testing/native-console/server.ts` |
| Tests | `tests/agents/local-runtime.test.ts` |
| Docs: preview platforms and how setup obtains the image | `docs/local-workspace.md` |

**Not verified:** a real launch on Windows, Linux with Docker Desktop, or Linux with gVisor. The
policy is unit tested. On this Mac, `runtime doctor` reports `engine_vm`, `linux/arm64`,
`install: build`.

## Invariants every workstream keeps

- Model credentials (ChatGPT, Claude, Bedrock) never enter the Linux worker. The harness runs on the
  host; the worker gets only an executor. The normal Session copy excludes host subscription login
  material. Workspace files and declared environment values can themselves contain secrets, so
  transfer review must not promise that arbitrary user content is credential-free.
- Local model requests use the selected subscription account. Inherited API keys must not change
  the provider or billing path. Handle sign-in expiry, revocation and quota errors explicitly;
  never recover them by switching to API-key billing.
- No mid-Run approval path. Fail closed on approval-shaped requests. Do not install Pi Durable
  approval-wait hooks or allow an extension/registry reload to widen an accepted Turn's authority.
- The local API binds `127.0.0.1` only, with a rotated bearer in a private connection file.
- Worker commands use argument arrays; never pass them through a shell on the host.
- `npm run architecture:check`: `core` must not import `runner`/`adapters`; `adapters` must not
  import `runner`/`app`.
- Visual work follows `BRAND.md`: neutral grays, a single `#828fff` accent, Inter 400/500/600.
- Docs in `docs/` and `guides/` describe current behavior only. Put validation narratives in PRs or
  in this `plans/` directory.

## Workstreams, in order

Each workstream has an exit criterion. Review the product flows first, then implement the managed
local runtime and distribution, finish AWS continuation, and prove the whole journey. Prepare the
live test procedure alongside implementation. Additional platforms, capabilities and harnesses
follow that baseline. Documentation evolves with each shipped behavior.

### 1. Review the product flows

Review these flows before another large implementation. They are proposed behavior, not screenshots
of the current dense setup modal. Build a small navigable review prototype using the existing Rat Things
palette, typography and artwork; show success and recovery states alongside the happy path.

| Flow | Screen and primary action | What the person should understand |
| --- | --- | --- |
| First run | **A little help, right at home** → **Set up this computer** | Work runs here; AWS is optional. Model requests still use an online provider. |
| First run | **Connect your ChatGPT subscription** → **Sign in with ChatGPT** | Rat Things uses a separate Codex login; it does not require an API billing account for this path. |
| First run | **Prepare your workspace** → **Prepare workspace** | Show detected compatibility, actual download size, disk requirement and proposed CPU/memory budget. Rat Things obtains and starts the environment. |
| First run | **Preparing your workspace** → **Finish later** | Download, verification and boot are distinct stages. Work continues in the Rat Things service; the app can reopen to the same operation. |
| First run | **Your workspace is ready** → **Try a small task** | A starter Session writes a visible file, then invites a follow-up. A green setup check alone is not the first result. |
| Everyday use | **This computer** → **New session** | Show running/queued/idle Sessions, memory/storage use, available capacity and sleep behavior. |
| Everyday use | **Workspace settings** → **Apply resource limits** | Changes affect future launches; retained files, backup and cleanup are explicit. |
| AWS | **Continue in AWS** → **Connect a deployment** or **Deploy in my AWS account** | The same Rat Things API and Session workflow use the selected destination. Show account and region. |
| AWS | **Review Session copy** → **Copy to AWS** | Show files/history, destination model, capability changes and any unsupported items. Review does not upload. |
| AWS | **Copying your Session** → **View progress** | Progress survives closing the window; retry reuses the transfer identity. |
| AWS | **Your cloud Session is ready** → **Open cloud Session** | The copy is imported and idle. A new message starts cloud work; the local original is retained. |

Recovery states must have a specific next action: **Resume download**, **Free disk space**,
**Sign in again**, **Restart workspace**, or **Retry copy**. Never show raw container commands as
the primary solution. Cancellation preserves completed downloads and existing Session files.
Do not fabricate image sizes, time estimates or cloud price quotes; use measured artifact metadata
and available deployment data. Errors stay literal; warmth belongs in welcomes and empty states.

- Split the dense setup modal in `desktop/src/app.rs` into three parts: first run (welcome →
  This computer → sign in → prepare workspace → starter task), workspace management, and transfer
  review. Follow the plan's copy guidance: warm welcome, literal states.
- Persist connection profiles. Today, choices last only for the current app launch. Add
  `rat-things --profile local|<name>` to the CLI and make the same profiles available in the SDK.
- Background service: `rat-things service install|uninstall|status` for launchd, systemd user
  units and a Windows service or Task Scheduler. Explain sleep behavior.
- Backup and export: one command that captures the data directory *and* the Session volumes.
  Volumes are currently a separate, manual backup.
- Capability discovery: `/v1/workspace` already returns `capabilities`. Give the AWS API the same
  shape, and have the desktop and SDK hide unsupported features per destination.
- **Review exit:** the prototype covers first run, everyday work and AWS continuation, including
  the recovery states above, and makes the installation and data-retention behavior reviewable.
- **Implementation exit (with workstream 2):** set up, work, close the app, return, and recover
  from sign-in expiry, a stopped managed environment or a full disk without implementation docs.

### 2. Managed local runtime and distribution

First implementation slice:
- Extract the runtime port and inject it at composition. Preserve existing engine behavior as a
  regression-tested advanced adapter; do not change public Session payloads to introduce a VM brand.
- Prototype the macOS helper and bootable Linux ARM64 image. Launch one real Session without an
  external container engine, write a file, stop the VM, restart it and read the same file. Exercise
  network denial and the host credential boundary, then record startup, memory and disk costs.
- Add durable provisioning operations and status/progress to the local service. Desktop and CLI
  attach to the same operation; a process restart reconciles VM and disk state instead of creating
  duplicate workers. Snapshot and transfer continue through the runtime port.
- Bundle and sign the native helper with the virtualization entitlement required by the selected
  implementation. Package the host runtime so first use needs no developer toolchain. The current
  ad-hoc signed desktop bundle is not a public signed/notarized installer.
- Build the unattended guest-image pipeline and signed release metadata. Verify downloads before
  activation, stage updates separately, and keep the previous usable image for rollback. Test
  installed-app and CLI behavior with Docker/Colima/OrbStack absent.

Local:
- CI builds the patched Codex Linux artifact for **arm64 and amd64**. Extend
  `scripts/codex-runtime-artifact.mjs` (currently arm64 only: `aarch64-unknown-linux-gnu`) and
  `runtime/codex/Dockerfile`. The managed runtime needs bootable VM artifacts as well as the
  worker payload. For the advanced engine path, build `runtime/local/Dockerfile` as a multi-arch
  image, publish it, sign it and write digests into `runtime/local/images.json` at release.
  Registry/signing choices are implementation proposals below, not already published services.
- Show managed-image download/verification/boot progress through the local API with restart-safe
  operations. For the advanced adapter, surface resumable `docker pull` progress through the same
  status contract instead of `stdio: 'inherit'`.
- Signed, notarized macOS app. `scripts/build-desktop.mjs` already bundles Node and the host Codex
  on macOS; add Linux (AppImage/deb) and Windows (MSI) bundles, which need a host Codex for each
  OS.
- Publish the CLI and SDK to npm (`npx rat-things`, plus an `@rat-things/sdk` export of
  `createLocalAgentsClient` / `readLocalConnection`). Docs currently import from `./dist/…`.
- One-line installers, `install.sh` and `install.ps1`, as Cua does.

Cloud (the "upgrade" half; currently it requires building the patched Codex from source):
- Publish versioned Lambda bundles, the MicroVM/worker images and the relay image as release
  artifacts.
- Add `rat-things cloud deploy` (evolve `npm run quickstart:aws`). It downloads the verified
  artifacts and applies `infra/modules/agent-runner` with no checkout. Keep `--dry-run` and
  explicit consent for credential copying.
- **Exit:** on a clean Apple silicon Mac with no external container engine, source checkout or
  compiler, a user can install Rat Things, provision its environment, complete a first local task and
  recover it after restart. The release also supplies the artifacts needed for workstream 3 to
  deploy into the user's AWS account without building from source.

### 3. AWS transition

- **Destination model selection: service and CLI implemented.** `POST /v1/workspace/transfers`
  accepts `model`; `transfer plan --model` exposes it. Plans report source and destination
  model IDs, validate the destination catalog before snapshot/upload, and preserve the reviewed
  model in an exact durable import request. A lost import response can be reconciled even after
  the catalog changes. The local Session is unchanged. Wire model selection and its review into
  the desktop flow next.
- **Local Bedrock.** Offer a Codex-on-Bedrock local mode with host AWS credentials, so moving to
  the cloud needs no model change. `bedrockTokenArguments` in `src/runner/agent-planning.ts` is the
  existing cloud path. Locally, credentials must stay in the host harness environment and never
  reach the worker.
- **Explicit opt-in subscription in AWS.** Offer the existing ChatGPT credential bridge
  (`docs/codex-subscription.md`, the quickstart consent flow) as a deliberate choice in the review,
  with its documented risk. Never enable it implicitly.
- Offer "Deploy to AWS" (workstream 2) from the review as well as connecting an existing
  deployment.
- Add transfer history (`GET /v1/workspace/transfers`) so an interrupted transfer can be found
  and resumed after a restart. Link source and destination Sessions, and distinguish
  `imported` from `continued`.
- Larger transfers: exclusion rules for caches and dependencies, plus a streamed snapshot.
  `LocalContainerRuntime.snapshot` currently buffers up to 150 MiB of JSON on stdout.
- **Exit:** a representative project moves into the user's AWS deployment, they understand every
  change, and an interruption doesn't force a restart.

### 4. Live correctness baseline

Prepare the repeatable test and fixtures alongside workstreams 2 and 3. A final fresh ChatGPT
sign-in needs the account owner's interaction; a live AWS run needs an explicitly selected,
authorized deployment. Those are final execution prerequisites, not reasons to defer the test
procedure, local implementation or failure fixtures.

- Script a repeatable journey in `testing/local-runtime/`: a fresh `--data-dir`, `rat-things login`,
  `runtime setup`, a Session with `openai_hosted` that writes a file, a restart, a second Turn,
  `transfer plan` / `run` against AWS, then a Turn in the cloud Session.
- Run the real local portion with API-key environment variables absent and subscription sign-in
  completed in Rat Things' private account store. Also cover an unrelated inherited API key: it must not
  be passed to the harness or used as fallback. Exercise subscription expiry/refresh and revoked
  login recovery. A fixture model or a successful API-key request does not verify subscription access.
- Inject failures: kill the service during upload, drop the import response (the
  `LocalTransferService` retry must recover the same destination Session), destination rejection,
  restore failure.
- **Exit:** the journey is documented as a test procedure in `testing/`. Run it once with the owner.
  Files and history are preserved, and there is no duplicate import.

### 5. Platforms

- **Windows** (endpoint support is already in): validate Docker Desktop with WSL 2 end to end.
  On Windows, `localCodexEnvironment` must set `USERPROFILE` (not only `HOME`). `chmod`
  0600/0700 on `storage.key`, `connection.json` and `codex/` does nothing there; use ACLs or
  DPAPI. Check path handling and `docker.exe` resolution.
- **Linux with gVisor**: verify that Codex's bubblewrap sandbox inside the worker works under
  `runsc`. It needs user namespaces and the added capabilities. Check the `--security-opt
  seccomp=unconfined` interaction, and find out whether `--runtime runsc` is also needed in
  rootless setups.
- **Isolation review**: Mac and Windows workers share the engine's VM with each other and with
  the user's other containers, and run with `seccomp=unconfined`. Document this in
  `docs/security.md` for the existing advanced adapter. The managed macOS runtime is a distinct
  boundary: test its per-Session VM proposal and report the actual configuration. Windows/Linux
  need Rat Things-managed provisioning implementations and isolation validation; recognizing an external
  engine alone does not satisfy the accepted first-run experience on those platforms.
- Remove a platform's `preview: true` in `localIsolation` only once it has passed the workstream 4
  journey.
- **Exit:** each platform passes the same journey and boundary tests, and its differences are
  documented.

### 6. Local capability parity

Local Files, MCP and plugins (explicitly admitted), Vaults with host-brokered credentials, browser
automation and local scheduling, all inside the fixed capability envelope. Local scheduling must
say that the computer and the service need to stay up. Change `LocalSessionExecution.prepare` and
`LocalManagedEnvironment.prepare`, which currently reject these.

### 7. Pi Durable harness (existing placeholder: `HarnessId = 'pi'`)

The owner's reference is
[`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare).
Inspected example revision: `dcb56ce2d174babb3f00112ac5b8cd597e58ab45`, which pins
`@earendil-works/pi-durable`, `pi-ai` and `chord` at `1.2.0`. The library README was also inspected
at Pi revision `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`; it is a different source snapshot and
must not be assumed to match the example's pinned API. Pi Durable is experimental. Pin and test
one compatible dependency set when implementing.

This replaces the earlier `pi --mode rpc` / `PI_CODING_AGENT_DIR` proposal. The example embeds a
library with a durable task engine, rather than wrapping the terminal coding agent. Its
`src/chat.ts` defines application composition; `src/session.ts` supplies Cloudflare Durable Object
SQLite storage, WebSockets and alarm recovery. Rat Things supplies its own host adapters and keeps its
existing AWS deployment. This reference does not add a Cloudflare deployment to our roadmap.

Architectural fit review now, implementation after the Codex baseline:

| Reference responsibility | Rat Things integration proposal and proof needed |
| --- | --- |
| Harness, conversations and submissions | Keep Rat Things' API as the public contract. Prototype one Pi harness storage per Rat Things Session with a root conversation; child conversations remain internal unless explicitly exposed. A Rat Things Turn maps to a submitted input/run, not mechanically to Pi's term "turn" (a model response and its tools). |
| Atomic durable storage | Implement an encrypted local backend/adapter that passes Pi's storage conformance suite. Rat Things' existing encrypted resource store is not automatically a conformant Pi storage backend. |
| One active storage owner | Rat Things retains ownership, dispatch and lease fencing. Test process restart, expired ownership and competing workers before permitting automatic task recovery. |
| Cloudflare alarm and SQLite | Replace with Rat Things wakeup and checkpoint/storage adapters for local and AWS. Preserve encrypted S3 content plus bounded DynamoDB metadata; prove commits survive worker loss before acknowledgement. Do not persist all Pi documents in DynamoDB or rely on ephemeral worker SQLite. |
| Execution environment | Implement Pi's execution-environment interface over the authenticated Rat Things worker transport. Never give agent tools the default host `NodeExecutionEnv`. The same adapter targets a local managed VM or an AWS worker. |
| Events, inbox and task graph | Project committed Pi state into Rat Things Items and status using stable identities/cursors. Rat Things and Pi must not independently dispatch the same input or emit duplicate terminal results. |
| Model provider | Replace the example's API-key configuration with supported host-side ChatGPT subscription authentication from the first live local prototype. Do not require `OPENAI_API_KEY`, fall back to API billing, read Codex's private tokens into a new adapter or assume sign-in is shared. Subscription login, refresh and completed inference are acceptance requirements. |

The upstream example's `OPENAI_API_KEY` setup is reference context only, not a Rat Things development
instruction. For the Pi provider investigation, OpenAI documents
[Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
and [OAuth-authenticated inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
Evaluate that documented flow against the selected Pi provider, registration requirements and
supported request fields. Preserve the existing Codex-owned login for the Codex adapter until a
deliberate shared-account design is implemented and verified. An SDK parameter called `api_key`
may transport an OAuth bearer token; validate credential origin and plan authorization rather than
equating the parameter name with API-key billing. Never ask the user to paste subscription tokens.

Recovery semantics require explicit design:
- A stable request ID deduplicates admission; it does not make arbitrary external side effects
  exactly-once. Pi can resume internal checkpoints and replay tools explicitly declared safe.
- Keep the same accepted Rat Things Turn/submission identity through recovery. Do not blindly resubmit
  it or reuse the current Codex adapter's "native start was attempted, therefore fail" policy for
  Pi. Map recoverable internal work to the existing Rat Things state machine and test terminal fencing.
- Commands, writes and external mutations are not replay-safe by default. Inject a crash after
  the external effect but before its result commit; use operation idempotency or report an
  interrupted/uncertain result. Read-only calls can opt into replay where their semantics permit.
- Pi supports extension changes and approval patterns that are broader than Rat Things' fixed capability
  envelope. Admit trusted definitions before launch, preserve their versions for pending work,
  and fail closed on authority expansion or approval-shaped execution.

Useful UX to adapt independently of selecting this harness:
- Visible queued follow-ups and committed acknowledgements; reconnect without submitting twice.
- An Activity view showing tool/subagent ownership, waits and background work.
- Conversation branching and scheduled follow-ups with explicit destination and sleep behavior.
- The example's client command outbox is an in-memory map. If Rat Things promises pending commands
  survive closing the app, persist them; reconnect retry alone does not provide that guarantee.

Transfer requires a versioned harness checkpoint format, supported task/extension versions and a
compatible destination harness. Keep the initial AWS copy idle-only. A history-only import into
another harness must be labelled as such and cannot claim to preserve pending durable tasks.
Do not promise live task migration from this example alone.

**Exit:** storage conformance; admission retry and competing-owner tests; model/tool crash tests;
queued-input and wakeup recovery; no duplicated side effects or terminal Items; a real tool-using
Session through Rat Things' isolated worker using ChatGPT subscription authentication with no API key;
verified login/refresh/revocation behavior; and an idle
local-to-AWS checkpoint import that continues under the same public Rat Things API. None is implemented
by the current harness placeholder.

### 8. Documentation and roadmap

Rebuild the learner path: Start on this computer → Connect your subscription → Give a Session a
workspace → Keep work running → Recover or back up → Continue in AWS. Reconcile
`docs/status-and-roadmap.md`, which lists as future work items that now have an initial
implementation. Update `site/docs.json` and `site/guides.json` when you add pages. Add notices to
`THIRD_PARTY_NOTICES.md` for any further Cua ports, and if pi is bundled.

## Remaining design choices

| Decision | Recommendation |
|---|---|
| Meaning of "pi-durable" | Settled by the supplied example: `@earendil-works/pi-durable`; embed the library behind a Rat Things adapter |
| Harness selection scope | Per workspace first; per Agent after a spec change |
| Image registry and signing | GHCR + cosign; digests committed in `runtime/local/images.json` |
| Provisioning ownership | Settled: Rat Things manages the environment in the first public release; existing engines are an advanced path |
| VM granularity | Prototype one VM per active Session on macOS; measure startup/memory/storage before production defaults |
| Subscription in AWS | Explicit opt-in only, with risk shown in the review |

## Verification

The reliability/subscription continuation passed `npm run check` with 1,314 passing
tests, plus packaging, site build and all Terraform validation roots. Nine complete
two-CPU native fixture journeys passed, totaling 27 VM boots. Earlier guest kernel
faults did not recur; their root cause remains unknown. The new real-subscription
acceptance executable is blocked on sign-in to the dedicated Rat Things profile; its
opt-in and unsigned-account guards pass. Token refresh/revocation and live AWS
copy/continuation are unverified.
Current evidence: `.codex/pstack-runs/managed-local/reliability-verification.md`.
The earlier native worker and container regression evidence remains in
`native-verification.md`; runtime-boundary/flow-review evidence is in `verification.md`.

```bash
npm run architecture:check
npx tsc --noEmit
npx vitest run tests/agents/local-runtime.test.ts tests/agents/local-workspace.test.ts \
  tests/agents/local-transfer.test.ts tests/agents/session-transfer.test.ts \
  tests/agents/workspace-transfer.test.ts tests/simulation/local-first-cli.e2e.test.ts
npm run check            # full suite; packaging needs the Linux ARM64 Codex artifact
npx tsx src/cli.ts runtime doctor --json
```

Lambda MicroVM provisioning and live AWS runs are opt-in. Never run them as part of ordinary checks.

Terraform follow-up: `.terraform-version`, CI and the LocalStack container now target 1.16.6.
All roots and the reusable module require `>= 1.9.0, < 2.0.0`, which supports the
`session_checkpoints_enabled` validation's reference to `var.enable_s3_files`. Upgrade older
local installations before running the checks. The earlier handoff failure occurred under
Terraform 1.5.7, when the declared minimum incorrectly allowed 1.5.0.

Verified after the upgrade: `npm run check` passed, including 1,297 tests, packaging,
site build and all three Terraform validation roots. `npm run test:infra` passed all
9 mocked-provider cases. The ARM64 Terraform container reports 1.16.6. Logs:
`/tmp/rat-terraform-1166-check.log` and `/tmp/rat-terraform-1166-infra.log`.

On this Mac, `terraform` resolves to `~/.local/bin/terraform`, linked to the official
1.16.6 ARM64 binary under `~/.local/share/terraform/1.16.6/`; its archive checksum was
verified against HashiCorp's published SHA256SUMS. Homebrew's upgrade was blocked by
outdated Command Line Tools, so its older installation remains separate. Provider
lockfiles were unchanged, and no AWS resources were applied.
