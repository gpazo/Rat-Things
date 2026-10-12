# Hibernating Sessions, live previews and Session forks

Date: 2026-10-11
Status: phase 1a, M1 and M3 live validated; disposable stacks cleaned up; activation defaults off
Inspiration: boat.dev (`boat stop`/`resume`, `boat fork`, `boat host`), Amp Orbs (shared app
previews), Grok Bot (persistent per-agent computers).

This plan covers three features. Hibernation and forking share quiescence and storage machinery,
but require different records: an **exclusive hibernation handoff** for the mutable Session root,
and an **immutable fork snapshot** that can be copied independently. Previews are a separate
workstream and do not depend on checkpoints.

| Workstream | User-visible result |
| --- | --- |
| 0. Checkpoint foundation | Internal only: exclusive workspace handoff and immutable fork snapshot contracts |
| 1. Hibernating Sessions | An idle Session can release its worker for hours or days and resume later with `/workspace` intact |
| 2. Live previews | The owner opens an authenticated URL to a dev server running inside a Session |
| 3. Session fork | A new Session starts from another Session's latest completed Turn, including workspace and native thread |

Read the "Ground truth" section before starting. Several assumptions from the original idea list were
wrong and the design below corrects them.

---

## Ground truth: baseline before phase 1a

### Idle handling already exists for MicroVMs

- Persistent (Session) MicroVM launches set a native Lambda MicroVM `idlePolicy`:
  `autoResumeEnabled: true`, `maxIdleDurationSeconds` (Terraform `microvm_session_idle_seconds`,
  default 1200, range 60–3600) and `suspendedDurationSeconds` (`microvm_session_suspended_seconds`,
  default 21600, max 27000). See `src/adapters/executors.ts` (`launch`, around line 88) and
  `infra/modules/agent-runner/variables.tf`.
- `maximumDurationInSeconds` is 28800 for persistent launches.
- A suspended MicroVM keeps its frozen process tree. AWS invokes the `suspend` hook
  (`syncPersistentStorage`) and the `resume` hook (`ensureS3FilesMounted`) in
  `microvm/runtime-server.mjs`. A port-authenticated proxy request auto-resumes it
  (`src/adapters/executors.ts` around line 301).

So for MicroVMs, "idle Sessions stop costing compute" is **already true for the first six hours**.
The real gaps are below.

### What ends a hosted environment today

- **Bounded harness lifetime (MicroVM).** `SessionRuntime` sets `lifetimeTimer` to
  `request.timeoutMs` when `lifetime !== 'host-managed'`. On expiry it sets `expired = true`, and
  `runAgentWorker` reports environment status `expired`, which is terminal: "create another
  Session" (`src/runner/session-runtime.ts`, `src/runner/main.ts` `finally` block,
  `docs/agents-api.md` "Environments and ownership").
- **Unexpected worker loss.** The next Turn starts a replacement worker. `prepareHostedEnvironment`
  sees `previouslyPrepared` and no local marker, so it calls `resetPersistentWorkspace(workspace,
  true)`, increments `reset_count` and emits `agent.session.environment.reset`
  (`src/runner/hosted-environment.ts`, `src/core/managed-environment-planning.ts`). The comment says
  "Old files in durable storage are not a checkpoint for a replaced sandbox." The native Codex thread
  survives because `CODEX_HOME` lives in the S3 Files state root and the runner uses `thread/resume`.
- **The setup marker is local.** The "already prepared" marker is
  `/tmp/rat-hosted-state/<environmentId>.json` on the worker, so every replacement looks unprepared.

### The EC2 backend never idles down

- EC2 placement uses `lifetime: 'host-managed'`. There is no idle policy. The instance runs until
  Session deletion or loss of execution authority (`src/adapters/ec2-executor.ts`,
  `src/runner/ec2-supervisor.ts`, `docs/costs.md`).
- `SessionRuntime` accepts `idleTimeoutMs`, but `src/runner/agent-driver.ts` (around line 90) never
  passes it. As written, it would *expire* the environment, which is terminal, rather than suspend it.

### The reconciler and suspension

- `MicrovmExecutionInspector.inspect` maps every non-`RUNNING` state, including `SUSPENDED` and
  `SUSPENDING`, to `{ kind: 'unknown' }` (`src/adapters/executors.ts` around line 167). That records
  uncertain liveness and quarantines after the third consecutive observation
  (`src/execution/reconciliation-planning.ts`). The reconciler runs every minute
  (`infra/modules/agent-runner/events.tf`).
- `reconciliationDecision` expires an `active` execution whose heartbeat is at least one hour old. A
  suspended worker cannot heartbeat. After a suspension longer than an hour, an inspection that lands
  between resume and the first new heartbeat would expire a healthy Session. The initial slice covers this race with planning, inspector and reconciler regression tests.
  Live validation must also exercise the deployed resume hook.
- `syncPersistentStorage` only logs a warning when `sync -f` fails (`microvm/runtime-server.mjs`
  around line 787). That is acceptable for suspension but not for a checkpoint that claims
  durability.

### State layout and transport facts the designs rely on

- The S3 Files state root is `/conversations/<sha256(owner, session)>`. It contains `workspace/` and
  `codex-home/`. `codex-home/` holds the `sqlite`, `browser-profile`, `.tmp`, `tmp`, `cache` and
  `plugins/cache` subpaths, some overlaid locally (`src/adapters/worker-launch.ts`,
  `microvm/runtime-server.mjs` around lines 286 and 696). The trusted root runner mounts the shared
  access point root, so it can technically read another Session's directory.
- MicroVM S3 Files is optional. Without it there is no durable workspace, so Workstreams 0, 1 and 3
  require S3 Files. EC2 placement already requires it.
- EC2 worker control is a DynamoDB command mailbox with a fixed allowlist
  (`src/core/execution-command-planning.ts` `validExecutionCommand`). It has no inbound network path
  and cannot carry streaming HTTP.
- MicroVM control uses `CreateMicrovmAuthToken({ allowedPorts: [{ port: 8080 }] })` plus the
  `x-aws-proxy-auth` and `x-aws-proxy-port` headers.
- The pinned Codex (`runtime/codex/source.json`, upstream 0.154.0 at `6b9826e`) exposes App Server
  `thread/fork` with `threadId` and an optional inclusive `lastTurnId`, plus
  `thread/rollback`. This was verified against the npm 0.154.0 binary's generated schema
  (`codex app-server generate-json-schema`). **Still verify against the patched Linux ARM64
  artifact.**
- The public Session `status` enum is fixed upstream: `idle | in_progress | requires_action |
  failed`. `idle` explicitly allows "a hosted environment may still be provisioning". The environment
  status enum is `pending | connected | disconnected | expired | failed`. None of these features may
  add public status values.
- `AGENTS.md` invariant: "Workers have no public or user-facing ingress. The MicroVM image listens
  only on the service-required lifecycle port." Workstream 2 needs an explicit amendment (decision
  D-P1).

---

## Workstream 0: Handoff and snapshot foundation

### Concept

A hibernation checkpoint is a host-written, durable, single-use handoff for a mutable Session
state root. All writers are stopped before commit, and remain stopped until an authorized successor
consumes the handoff. A live source must never retain an adoptable hibernation checkpoint.

A fork snapshot is an immutable, independently owned copy. It is never an adoption permit for the
source's mutable root. The source's runtime revision is not a filesystem revision: background
commands and environment-file operations can mutate files without updating it.

### Records

Store the hibernation handoff on the managed environment record (`StoredEnvironment`). Store fork
snapshots separately with their own lifecycle and retention. Neither record contains credentials.

```ts
interface WorkspaceCheckpoint {
  id: string;
  sandboxId: string;
  setupDigest: string;             // materialized inputs/packages/setup, excluding network policy
  policyDigest: string;            // full resolved execution policy, validated independently
  rootThreadId: string;
  lastRootTurnId: string | null;
  lastNativeTurnId: string | null;
  source: { runId: string; generation: string };
  reason: 'hibernate';
  createdAt: number;
}

interface ForkSnapshot {
  id: string;
  sourceSessionId: string;
  sourceCheckpointId: string;
  storageKey: string;              // host-derived immutable snapshot location
  setupDigest: string;
  sourcePolicyDigest: string;
  rootThreadId: string;
  lastRootTurnId: string | null;
  lastNativeTurnId: string | null;
  sizeBytes: number;
  createdAt: number;
}
```

### Hibernation protocol

1. Atomically fence admission for the exact Run/generation. Serialize with in-flight native starts,
   tool results and environment-file writes; reject new writes with a retryable error. Recheck that
   no root or subagent Turn and no required action remains after acquiring the fence.
2. Enter a private runtime `quiescing` state. Closing the App Server currently resolves
   `SessionRuntime.finished` and lets the runner finalize the Run. Introduce a shutdown barrier so
   native exit during this protocol does not finalize the Run or overwrite checkpoint state.
3. Stop guest background writers and gracefully close the native harness. Verify the pinned native
   shutdown actually flushes rollouts; a forced kill or ambiguous flush cannot produce a checkpoint.
   Flush and acknowledge the Session journal after native closure.
   **Activation prerequisite:** the pinned App Server logs thread-shutdown submission failures and
   timeouts while continuing process exit. A zero exit code alone is insufficient. Add an explicit
   per-thread flush-and-shutdown acknowledgement before wiring the production checkpoint path.
4. Strictly sync persistent storage. Failures produce no adoptable checkpoint.
5. Commit the handoff conditionally against environment identity, Run and execution generation,
   while the admission fence remains held. Only then resolve the shutdown barrier, finish the Run
   and release the worker.
6. On a failure after native shutdown, settle the private transition and Run explicitly. A later
   replacement without a committed handoff follows existing reset semantics. Never leave a Session
   permanently fenced. Recovery must inspect durable transition state after a host crash.

### Fork snapshot protocol (v1)

Use hibernation as the quiescence mechanism in v1. A live idle source is hibernated first; native
conversation and workspace survive, but background processes stop. Do not promise an uninterrupted
source process tree. Its next input resumes it through the normal handoff path.

Acquire a durable, bounded snapshot lease on the source handoff before copying. While leased,
source adoption, environment-file writes and deletion of source bytes must wait or return a
retryable conflict. Copy into a private staging root, exclude transient state and credentials,
enforce byte and time limits, sync, and then atomically publish the immutable snapshot record.
An expired/abandoned lease must fence out its old copier; incomplete staging roots are never
adoptable. Release the lease only after snapshot commit or cleanup. A fork consumes its own copy,
not the source handoff. Source deletion after snapshot commit must not break the fork.

### Adoption

- Require the exact sandbox and setup digest for a hibernation handoff, and validate the current
  execution policy separately. Derive storage paths on the host from authorized records.
- Consume the handoff in the conditional write that binds the successor Run/generation. Prevent
  any old worker or expired snapshot lease from writing after that claim. A crash after consumption
  retains today's reset semantics unless a subsequent clean handoff was committed.
- Preserve workspace bytes and sandbox identity; skip files, capabilities and setup commands.
  Reinstall only system packages on the new root filesystem. Refresh credentials through normal
  preparation and never treat copied configuration as authority.
- A fork validates equal-or-narrower policy, assigns a new sandbox identity, and adopts a committed
  snapshot using its setup digest. Narrowing network policy must not invalidate setup compatibility.
- Keep the private local setup marker as a same-worker fast path only.

### Files

| Layer | Change |
| --- | --- |
| `src/domain` | `WorkspaceCheckpoint`, `ForkSnapshot` and pure validation (no AWS imports) |
| `src/core/managed-environment-planning.ts` | Pure `planCheckpointWrite` and `planCheckpointAdoption`; extend `planManagedReadiness` to accept an adopted sandbox |
| `src/core/environment-service.ts` | Handoff writes/consumption, snapshot leases, generation fences and crash recovery |
| `src/runner/hosted-environment.ts` | Adoption branch |
| `src/runner/session-runtime.ts`, `src/runner/main.ts` | Quiesce-and-checkpoint path, distinct from `expired` |
| `microvm/runtime-server.mjs` | Strict sync that returns a status |

### Tests

- Planning: valid adoption, setup mismatch, sandbox mismatch, double adoption, stale generations,
  policy narrowing/widening, lease expiry, and source deletion during snapshot preparation.
- Effects: adoption keeps workspace files and `resetCount`; a missing checkpoint still resets and
  emits `environment.reset`; a sync failure writes no checkpoint. Inject failure after each protocol
  step and verify eventual settlement, cleanup and no premature Run completion. Test source resume
  and deletion racing snapshot copy, background writers, symlinks and byte-limit exhaustion.
- Architecture: `npm run architecture:check` still passes, and `src/domain` stays AWS-free.

---

## Workstream 1: Hibernating Sessions

### Behavior to publish

| Phase | Worker | Processes | `/workspace` + native thread | Public Session / environment status | Resume cost |
| --- | --- | --- | --- | --- | --- |
| Live | running | yes | yes | `idle` or busy / `connected` | none |
| Suspended (MicroVM native, after `microvm_session_idle_seconds`) | frozen | **kept** | yes | `idle` / `disconnected` after the connection lease expires | seconds, on next control request |
| Hibernated (new) | **released** | **lost** | **kept** (checkpoint) | `idle` / `disconnected` | cold worker start + system packages |
| Resuming | starting | none yet | kept | `idle` / `pending` | — |
| Expired / failed (unchanged) | gone | lost | workspace reset on any replacement | terminal | create another Session |

The public environment remains `disconnected` during native suspension once its 45-second
connection lease expires; this is compatible with automatic resume. Do not infer hibernation solely
from that public value. Private execution inspection distinguishes suspension from released compute.

Packages installed into `/workspace/.packages` (npm and pip) survive hibernation. System (`dnf`)
packages are reinstalled on resume. Anything else written outside `/workspace` during setup or by
the agent is lost. **State this table in `docs/agents-api.md` and `docs/costs.md`**, as boat.dev
does for `stop`.

### Triggers

1. **EC2 idle.** New Terraform variable `ec2_session_hibernate_after_seconds` (default `null`, which
   keeps today's behavior), passed through the launch template into `SessionRuntime` as a new
   `hibernateAfterMs`. Do not reuse `idleTimeoutMs`, whose semantics are expiry. When the timer
   fires, run the Workstream 0 protocol, finish the Run, and let the supervisor terminate the
   instance.
2. **MicroVM before suspended retention ends.** The VM is frozen and cannot act on its own, so the
   control plane triggers this. The reconciler, or a small scheduled sibling, finds Sessions whose
   MicroVM is `SUSPENDED` with less than a margin (say 30 minutes) left of
   `microvm_session_suspended_seconds`, also bounded by the platform maximum lifetime. Verify whether
   that lifetime includes suspended time and schedule against the earliest deadline. It enqueues a new allowlisted execution command `hibernate`.
   The proxy request auto-resumes the VM, which then runs the protocol and self-terminates.
3. **MicroVM bounded lifetime while idle.** If `lifetimeTimer` fires with no active Turn,
   hibernate instead of expiring. If a Turn is active, keep today's `expired` behavior: a running
   Turn cannot be checkpointed.
4. **Owner-initiated (optional phase 1c).** A Rat Things extension
   `POST /v1/agents/sessions/{session_id}/hibernate` (scope `api.agents.write`) for "stop now and
   pause billing", like `boat stop`. It returns `409` if the Session is not idle.

### Resume

Input to a hibernated Session follows the existing path. `SessionService.events` → dispatch → new
Run → new worker → `prepareHostedEnvironment` adopts the checkpoint → `thread/resume` against the
same `codex-home`. No new public API is needed. The extra latency is the cold start plus system
package installation. Record a startup metric labeled `mode=hibernate-resume`, alongside the
existing `observeStartup` modes.

### Reconciler corrections (ship first as phase 1a; low risk)

- Map MicroVM `SUSPENDED` and `SUSPENDING` to a new inspection kind `suspended`. It records an
  observation, never counts toward quarantine, and is never `expire`d for heartbeat age.
- The trusted lifecycle `resume` hook records `lastResumedAt` on the active Run before returning
  `200`. Return it from the generation-checked health endpoint. Measure heartbeat age from
  `max(heartbeatAt, lastResumedAt)`; malformed/future evidence cannot extend the grace period.
  Keep durable heartbeat/generation compare-and-swap fencing on repair writes. This avoids a
  second heartbeat writer in the lifecycle server. Older images without resume evidence retain
  existing expiry behavior; deploy the image and reconciler together.
- Environment keep-alives distinguish confirmed authority loss from transient storage failures.
  A thawed socket may fail once after resume. Retry serially, reset the error budget on success,
  and fail closed after three consecutive errors; verified retirement, replacement or deletion
  still stops the worker immediately. Use attempt counts rather than elapsed frozen wall time.
- Add planning tests in `tests/execution/reconciliation-planning.test.ts` and inspector tests in
  `tests/adapters/execution-inspector.test.ts`.

### Files

`src/execution/reconciliation-planning.ts`, `src/execution/reconciler.ts`,
`src/adapters/executors.ts`, `src/adapters/ec2-executor.ts`, `src/runner/session-runtime.ts`,
`src/runner/agent-driver.ts`, `src/runner/main.ts`, `src/runner/ec2-supervisor.ts`,
`src/core/execution-command-planning.ts` (allow `hibernate`), `microvm/runtime-server.mjs` (trusted
resume evidence), `infra/modules/agent-runner/{variables,ec2-worker,lambda}.tf`, `docs/agents-api.md`,
`docs/costs.md`, `microvm/README.md`, `infra/README.md`.

### Acceptance

- Local: the EC2 idle timer hibernates, and the next input resumes with a marker file intact,
  `reset_count` unchanged, no `environment.reset` event and the same native thread ID.
- Local: an active Turn at the lifetime deadline still expires.
- Reconciler: suspension never quarantines or wakes a VM for inspection; cancelling a suspended
  Run still stops it. Resume with a stale pre-suspension heartbeat does not expire, but expiry
  resumes after an hour without a new heartbeat. Identity and heartbeat races remain fenced.
- Live phase 1a proof: an explicitly opted-in disposable MicroVM Session suspends, remains suspended
  across repeated deployed reconciliation, resumes with the same execution/native context, and
  completes a second Turn. Fault-inject only its fenced heartbeat to exercise the one-hour race
  without claiming an hour-long wall-clock soak. Verify cleanup separately.
- Opt-in live AWS (never in ordinary tests): one EC2 and one MicroVM Session hibernate and resume
  with workspace continuity, and the instance or VM inventory shows the worker released while
  hibernated.

### Decisions

- **D-H1. Default for `ec2_session_hibernate_after_seconds`.** Recommendation: `null`, so it is
  opt-in, because EC2 placement exists for uninterrupted long-running work.
- **D-H2. Re-run `setup_commands` on adoption?** Recommendation: no. They already ran against the
  preserved `/workspace`, and re-running them is not guaranteed to be idempotent. Document that
  setup effects outside `/workspace` do not survive hibernation.
- **D-H3. Expose owner-initiated hibernation (trigger 4) in v1?** Recommendation: yes, after
  triggers 1–3 pass. It is small once the protocol exists.

---

## Workstream 2: Live previews

### Behavior

The owner asks for a preview of a port the agent is serving inside a live Session. They get a URL
on an isolated user-content host that proxies HTTP and WebSocket traffic to that port. It is
owner-only in v1. Grants expire and are revoked when the Session is deleted or its worker is
released.

```http
POST /v1/sessions/{sessionId}/previews          (IAM control API, beside publications)
{ "port": 5173, "ttl_seconds": 3600 }
→ { "id": "prev_…", "url": "https://p-<id>.<preview domain>/__preview/<token>", "expires_at": … }

GET    /v1/sessions/{sessionId}/previews
DELETE /v1/sessions/{sessionId}/previews/{previewId}
```

CLI: `rat-things sessions preview SESSION_ID --port 5173`. The console gets an "Open preview"
action on live hosted Sessions.

### Architecture

- **Preview gateway.** A small new Fargate service, opt-in via `enable_session_previews`, behind
  its own load balancer and a wildcard certificate for the preview domain. It is separate from the
  API service so that the API origin never serves agent content.
- **Owner authentication and exchange.** Publication links are bearer grants and cannot establish
  owner identity. The preview URL is an entry point, not sufficient authorization. Redirect through
  an authenticated control-origin browser session, verify its principal owns the Session, then
  issue a short-lived single-use exchange code bound to preview, execution generation and browser
  nonce. The gateway redeems it server-side and sets a host-only `__Host-` cookie (`Secure`,
  `HttpOnly`, `Path=/`, `SameSite=Lax`). Never forward API credentials to the content origin.
  Specify the browser login/CLI handoff before M4; possession of a copied URL alone must fail.
  Every request revalidates owner binding, Session, execution generation, port, expiry and revocation.
  Expiry/revocation also closes existing HTTP streams, WebSockets and worker tunnels. Reserve
  exchange paths and cookie names; prevent upstream Set-Cookie from replacing gateway credentials.
- **MicroVM forwarding (phase 2a).** Resolve the Session's current Run and execution. Require
  `dispatching` or `running` with a matching generation. Call `GetMicrovm`, then mint
  `CreateMicrovmAuthToken({ allowedPorts: [{ port }], expirationInMinutes: 2 })`, cached per
  execution and port for under two minutes. Forward to the endpoint with `x-aws-proxy-auth` and
  `x-aws-proxy-port`. Strip inbound `Cookie` (gateway cookie), `Authorization` and all `x-aws-*`
  headers. Bound request and response sizes and durations. Send `cache-control: no-store`.
- **EC2 forwarding (phase 2b).** EC2 has no inbound path, and the DynamoDB mailbox cannot stream.
  The trusted runner opens an outbound WebSocket tunnel to the gateway, authenticated with a
  per-execution credential that the agent UID cannot read. The gateway multiplexes preview streams
  over it, and the runner connects to `127.0.0.1:<port>` inside the worker. Reuse the stream-ID
  framing ideas from `src/domain/relay-frame.ts`, but do not reuse the relay's Noise keys or roles.
- **Port policy.** A deployment allowlist (`session_preview_ports`, for example
  `[3000, 4173, 5173, 8000]`). Always exclude 8080, the lifecycle port. Invalid ports fail with `400`
  before any effect.
- **Hibernated or absent worker.** Serve a static "Session is not running" page. A preview never
  launches a worker. Preview traffic to a suspended MicroVM auto-resumes it, by AWS proxy design;
  document that this counts as activity.

### Security analysis to carry into review

- Ingress is to agent-served content for the **owner's browser only**. It grants the agent no new
  authority: no credentials, no egress change, no new tools. This is the argument for D-P1.
- Agent content is untrusted HTML and JavaScript. Mitigate as publications do: a per-preview host
  on a separate registrable domain, host-only cookies, no API credentials on that origin, and strict
  header stripping.
- Grants live in encrypted storage, are bound to the owner, and are short-lived. Session deletion
  revokes them, so execution authority ending also closes previews.
- The agent cannot mint or read grants. Grant minting is an owner API call.

### Spikes (before committing to 2a)

- **S-P1.** Does the Lambda MicroVM ingress proxy forward arbitrary allowed ports, and does it
  support WebSocket upgrade (needed for Vite/Next HMR)? Does it forward to the guest's loopback or to
  its interface? That determines whether agents must bind `0.0.0.0`.
- **S-P2.** What latency and throughput does the proxy add for a typical dev-server page load?

### Files

New `src/core/preview-service.ts` and `src/domain/previews.ts` (grant and port validation, pure).
New adapter `src/adapters/preview-forwarding.ts` (MicroVM token and forward). New transport entry
`src/preview-gateway.ts`. Control routes in `src/lambdas/control.ts` and
`infra/modules/agent-runner/api.tf`. New `infra/modules/agent-runner/previews.tf`. For 2b, runner
tunnel code in `src/runner/` plus a gateway tunnel endpoint. Docs: new `docs/previews.md`, plus
updates to `docs/security.md`, `docs/sharing-work.md` and `AGENTS.md`.

### Acceptance

- Unit tests: grant validation, port allowlist, header stripping, owner mismatch, an expired or
  revoked grant, and a Session with no live execution. A different browser with a copied URL cannot
  authenticate; wrong-owner login fails; expiry/deletion terminates already-open WebSockets.
- Opt-in live test: a Vite dev server in a MicroVM Session loads through the preview URL, HMR
  WebSocket works, and the URL stops working after Session deletion.

### Decisions

- **D-P1. Amend the ingress invariant (gating).** Proposed `AGENTS.md` wording: "Workers have no
  public ingress. The only user-facing path is the owner-authenticated preview gateway, which
  forwards to allowlisted ports over the platform-authenticated proxy or a worker-initiated tunnel;
  workers never accept unauthenticated connections." If this is not accepted, Workstream 2 stops.
- **D-P2. Domain.** Recommendation: reuse `publication_base_domain` with a distinct `p-` host label
  and its own wildcard certificate. The alternative is a separate registrable preview domain.
- **D-P3. Sharing beyond the owner.** Recommendation: v1 owner-only. Later, add expiring bearer
  grants like publications.
- **D-P4. Should agents be able to suggest a preview?** Recommendation: not in v1. A later option is
  a declared function tool that *requests* a preview the owner then opens, which keeps grant minting
  outside the guest.

---

## Workstream 3: Session fork

### Behavior

```http
POST /v1/agents/sessions/{session_id}/fork        (Rat Things extension; SDK users call client.post)
{
  "metadata": { "attempt": "b" },                 // optional; replaces, never inherits, user metadata
  "vault_ids": ["vault_…"],                       // optional; must be a subset of the source's
  "environment": { "network": { … } },            // optional; may only narrow the source policy
  "input": [ … ]                                  // optional first message for the fork
}
→ 201 agent.session   (a standard Session object for the new Session)
```

The fork starts from the source's **latest terminal root Turn**. A live source is hibernated to make a consistent snapshot; its processes stop, and its next input
resumes the preserved workspace and conversation. The fork
is owned by the same owner, derived from the principal. It uses the source's **snapshotted** Agent
configuration (not the saved Agent's current version), the same placement, and an equal or narrower
envelope. Provenance is readable at `GET /v1/agents/sessions/{session_id}/lineage`, which returns
`{ forked_from: { session_id, turn_id, created_at } | null }`. Provenance lives in a private record,
not in user `metadata`.

Scopes: `api.agents.read` and `api.agents.write`, plus `api.responses.write` when `input` is present.
This matches the existing pre-effect checks.

Supported environments in v1: `openai_hosted` with S3 Files. Reject `none` and `self_hosted`
with `400`. History-only forks need a separate durable history snapshot and recovery path; they
are deferred rather than relying on a managed environment record that does not exist.

### Flow

1. **Admission** (`SessionService.fork`, new pure `src/core/session-fork-planning.ts`).
   - Owner check on the source.
   - Preconditions: source status `idle`, no `required_actions`, a supported environment type.
   - Validate narrowing for vaults, network and tools. Reuse the network-narrowing rule in
     `resolveHostedEnvironment` (`src/domain/environment-planning.ts`). Add a pure subset check for
     vaults and tools.
   - Create a normal Session preparation (`planSessionPreparation`) with the source snapshot and a
     `fork` descriptor `{ sourceSessionId, sourceEnvironmentId, snapshotId }`.
2. **Source handoff and snapshot.** Apply Workstream 0's hibernation and snapshot lease protocol.
   A hibernated source does not need a worker. A suspended source wakes only to checkpoint. A live
   idle source stops its processes and releases its worker before the immutable snapshot is copied.
   Record both public and native Turn IDs at the handoff; do not resolve them from changing state later.
3. **Copy** (trusted snapshot worker, before any fork agent starts). Derive source/destination roots
   from owner-authorized records. Reject traversal and escaping links; never follow guest-controlled
   symlinks while copying as root. Exclude `codex-home/{sqlite,.tmp,tmp,cache,plugins/cache}`,
   `browser-profile`, `auth.json` and transient workspace mounts. Enforce the v1 256 MiB copy cap, 50,000 traversal/copy steps and 90-second copy deadline
   while copying and publish only after successful sync. The first fork worker copies from this
   committed immutable snapshot, with idempotent retries and cleanup of partial destinations.
4. **Native thread.** The fork harness calls `thread/fork { threadId: sourceRootThreadId,
   lastTurnId: snapshot.lastNativeTurnId }` instead of `thread/resume`, using newly prepared policy,
   tools and credentials. Verify on the patched runtime that native defaults cannot restore source
   authority. Persist the returned `rootThreadId` before releasing snapshot retention. Subagent
   threads are not carried over. v1 rejects sources without a terminal root Turn; an explicit empty-thread branch is deferred.
5. **Environment.** The fork gets a new environment and sandbox identity. It adopts the immutable
   copy using the setup digest and a separately validated equal-or-narrower execution policy.
   `reset_count` starts at 0. Do not synthesize an adoption permit with the old full-policy digest.
6. **Credentials.** Vault, MCP and environment-credential bindings are re-prepared through the
   normal Session preparation path. Secret references are never copied from the source.

### Spikes

- **S-F1.** On the patched Linux artifact: `thread/fork` with `lastTurnId` on a `CODEX_HOME` that
  was copied to a **different absolute path**. The state root includes the per-Session hash. Do
  rollouts or config embed absolute `CODEX_HOME` or `cwd` paths that break after the copy?
  `/workspace` is a stable bind mount, so the workspace `cwd` should be fine.
  Completed by the local native cut-point test and the AWS Linux ARM64 M3 scenario below.
- **S-F2.** A 1 GB workspace exceeds the conservative v1 256 MiB cap. Benchmark larger
  `node_modules` trees before raising that cap or introducing S3-side copies. This is follow-up
  capacity work, not a prerequisite for the bounded v1 implementation.

### Decisions

- **D-F1. Fork from older Turns?** Recommendation: not in v1. Workspace files reflect the latest
  state, so forking history from Turn N with files from Turn N+k would be inconsistent. Per-Turn
  workspace snapshots are a separate, larger project.
- **D-F2. Copy the browser profile?** Recommendation: no. It carries authenticated browser
  sessions, and duplicating them silently widens where those sessions live. Offer an explicit opt-in
  later if needed.
- **D-F3. Fork Items and Turns.** Recommendation for v1: the fork starts with **empty** Items and
  Turns plus the lineage pointer. The native thread carries the context. The trade-off: if the
  source is later deleted, its pre-fork history is no longer listable through the API, and the
  fork's replacement-recovery replay (`recoveryItems`) would otherwise have no pre-fork Items.
  Retain a private durable pre-fork recovery history snapshot independent of source deletion and
  inject it before post-fork Items when native history is missing. Public Item/Turn copying with
  new IDs remains a v2 option; silent loss of native context is not an accepted recovery behavior.
- **D-F4. API placement.** Recommendation: the Agents API path as a documented Rat Things
  extension, like Files, Skills and webhooks. The alternative is the IAM control API beside
  publications.

### Files

`src/core/session-service.ts` (`fork`, `lineage`), new `src/core/session-fork-planning.ts`,
`src/domain` validation, `src/app/run-session-execution.ts` (`prepareFork`),
`src/runner/fork-workspace.ts` and `src/runner/main.ts` (copy and snapshot publication),
`src/runner/session-runtime.ts` (`thread/fork` branch in `initialize`),
`src/core/execution-command-planning.ts` (allow fenced snapshot coordination), route registration and generated
route checks (`npm run agents-api:routes:check`), `src/agents-cli.ts`
(`sessions fork SESSION_ID`), and `docs/agents-api.md`.

### Acceptance

- Planning: narrowing accepted and widening rejected (vault superset, network enabled from
  restricted), source busy or `requires_action` rejected, `self_hosted` and `none` rejected, owner mismatch
  returns 404.
- Effects (local harness): the fork sees the source workspace file and recalls the source
  conversation marker. A new file in the fork does not appear in the source, and vice versa. The
  source resumes normally on its next input. Forking a hibernated source does not start a source worker.
- Opt-in live test: three forks from one prepared "golden" Session each complete a Turn without
  re-running setup.

---

## Sequencing

| Milestone | Contents | Depends on | Notes |
| --- | --- | --- | --- |
| M0 | Reconciler suspension/resume fix (phase 1a); separate spikes S-F1, S-P1 | — | Phase 1a is the initial implementation slice; spikes remain prerequisites for fork/preview work |
| M1 | Workstream 0 handoff state machine and immutable snapshot foundation, behind a feature flag | — | No behavior change while the flag is off |
| M2 | Hibernation: EC2 idle, MicroVM lifetime and retention triggers, docs table | M1 | Owner-initiated hibernate (D-H3) follows |
| M3 | Fork | M1, S-F1 | Explicit checkpointing quiesces live sources; automatic M2 policy triggers are not required |
| M4 | Previews, MicroVM (2a) | D-P1 accepted, S-P1 | Can run in parallel with M2 and M3 |
| M5 | Previews, EC2 tunnel (2b) | M4 | |

M1 is split into M1a (storage state machine, adoption preparation, barrier ports and storage proof)
and M1b (native flush acknowledgement, actual worker/control admission wiring, writer termination,
strict sync integration and live worker replacement). M1a does not complete M1 or enable M2.

## Decisions needed before work starts

| ID | Question | Recommendation | Blocks |
| --- | --- | --- | --- |
| D-P1 | Amend the worker-ingress invariant for an owner-authenticated preview gateway | Accept the proposed wording | M4, M5 |
| D-H1 | EC2 hibernation default | Off (`null`) | M2 |
| D-H2 | Re-run `setup_commands` when adopting a checkpoint | No; document | M1 |
| D-F3 | Fork copies Items and Turns, or uses lineage only | Public lineage plus private recovery history in v1 | M3 |
| D-F4 | Fork route on the Agents API (extension) or the control API | Agents API extension | M3 |
| D-P2 | Preview domain | Reuse the publication domain with a `p-` label | M4 |

## Out of scope

- Disk-level snapshots or EC2 stop and hibernate. The checkpoint is file-level through S3 Files.
- History-only (`none`) forks and uninterrupted live-source fork snapshots.
- Preserving processes across hibernation. Native MicroVM suspension already does this within its
  retention window.
- Per-Turn workspace history and forking from arbitrary Turns.
- Public preview sharing, custom preview domains and agent-minted preview links.
- Draft-PR output and Agent-scoped memory, from the original idea list. Plan them separately.

## Handoff notes

- Follow `AGENTS.md` boundaries. Pure decisions go in `src/domain` or `*-planning.ts`, effects in
  adapters and the runner, and `src/app` stays the composition root. Run `npm run check` after code
  or Terraform changes.
- Never provision a Lambda MicroVM or EC2 worker in ordinary tests. Gate every live check above
  behind the existing opt-in AWS harness (`testing/aws`).
- `docs/` pages describe resulting behavior only. Put validation narratives and run IDs in PR
  descriptions or under `plans/`.
- The upstream Session and environment status enums must not change. New states are private
  records mapped onto the existing values as shown in the Workstream 1 table.

## Initial implementation scope

The first implementation slice is phase 1a: suspended inspection without proxy traffic, trusted
resume evidence on the existing health route, bounded environment keep-alive recovery, and expiry/cancellation regression coverage. It
does not implement hibernation, snapshots, fork routes or preview ingress. Live validation uses
a disposable stack and an explicit suspension proof; record results and remaining blockers here
or in a companion validation artifact after running it. AGENTS.md stays unchanged until the
preview owner-authentication design and its implementation are ready together.

## Phase 1a validation — 2026-10-11

Implemented suspended/SUSPENDING inspection without proxy traffic, a private suspended liveness
outcome, trusted generation-checked resume evidence, bounded environment keep-alive retries,
and regression coverage for expiry, cancellation and conditional-write races. Public status enums
and the worker-ingress invariant remain unchanged. The checkpoint, hibernation, fork and preview
workstreams are still planned; S-F1 and S-P1 have not been completed by this slice.

| Check | Result |
| --- | --- |
| `npm run check` with Terraform 1.15.8 | Passed: 1,155 tests, 53 intentional skips, packaging, architecture/schema/routes and Terraform validation |
| `npm run test:infra` with Terraform 1.15.8 | 9 passed |
| `npm run smoke:local` | Passed |
| Opt-in `tests/aws/session-suspension.test.ts` | Passed against candidate MicroVM image 2.0 in 85.49 seconds |
| Worker after test | Independently observed `TERMINATED` |
| Disposable stack cleanup | Completed: 269 resources destroyed; tagged-resource audit passed |

The passing AWS fixture was Session `sess_17ccb8f416aa4704b3b77427425fc64a`, Run
`882fc17f-9f33-5213-a0eb-47b46c2c2443`, MicroVM
`microvm-477fb0d2-7c66-3dd5-80a3-765019e43cbd`, on disposable deployment
`hib261011a` in `us-west-2`. Its native root thread stayed
`01a12ca2-1f91-7e60-bf64-4b362e909b73` across resume.

The proof forces native suspension, conditionally ages only the fixture's heartbeat, invokes the
deployed reconciler four times without waking or quarantining it, resumes through the authenticated
proxy, proves the stale-heartbeat/fresh-resume race is protected, completes a second real model
Turn with the preserved file and native thread, then deletes the Session while suspended again.
It does not prove the automatic idle timer, an hour of wall-clock suspension, hibernation, forks or
previews.

The first live attempt passed suspended reconciliation but exposed worker shutdown after thawing:
network writes returned `ECONNABORTED`, while the environment keep-alive aborted on every error.
The final implementation distinguishes verified authority loss from failed storage requests,
retries the latter serially, resets the failure budget after success, and fails closed after three
consecutive failures. The unchanged live assertions then passed on image 2.0.

Deployment also exposed a null-argument error in the ChatGPT model-catalog Terraform check under
Bedrock configuration. A conditional now avoids evaluating `contains` with a null model; the
existing unconfigured-model infrastructure test and the real deployment both pass.

Local evidence is retained under `.aws-e2e/hib261011a/`: `suspension-proof.json`,
`first-live.log`, `passing-live.log`, `repository-check.log`, `infrastructure-tests.log` and
`local-smoke.log` and `stack-cleanup.log`. These are ignored harness artifacts; this section records the durable summary.

## M1a foundation — 2026-10-11

Implemented the internal foundation; this is not production hibernation and does not complete M1.
No production composition creates an enabled `WorkspaceHandoffService`, no API or lifecycle trigger
calls it, and `SessionRuntime.finished` is not yet wired to the new completion barrier.

- `src/domain/workspace-checkpoint.ts` defines the exclusive handoff, per-process adoption receipt,
  snapshot lease and independently owned snapshot record. Setup digests exclude network policy;
  the initial adoption path requires an equal policy digest. Equal-or-narrower fork policy remains
  an M3 requirement. Compute digests from the immutable launch, before preparation expands roots;
  full fixed-execution-envelope admission must still run when wiring a successor.
- `src/core/workspace-handoff-planning.ts` and `workspace-handoff-service.ts` implement conditional
  begin/commit/adoption/abort/recovery and transactional snapshot publication. Adoption atomically
  binds the successor Run and generation. A fresh process must use a fresh attempt ID; a crash after
  consumption cannot reuse the permit. Recovery requires positive termination evidence for the
  exact previous execution, not a stale heartbeat or elapsed lease. Recovery's single conditional
  write loses to concurrent record changes.
- Snapshot leases prevent adoption and environment retirement during copy admission. Every lease
  has a separate host-derived destination key, so an abandoned copier cannot overwrite a later
  snapshot. Expired copiers cannot publish. This slice implements records and publication, not the
  bounded physical copier, immutable-object enforcement or staging cleanup.
- `src/runner/workspace-handoff.ts` implements admission draining and ordered shutdown, writer,
  journal, sync and commit ports. It rejects forced, incomplete or missing native flush evidence.
  Completion stays behind commit or failure settlement. These ports are tested but are not yet
  connected to live Session control operations or the worker process tree.
- `src/runner/workspace-sync.ts` makes a nonzero or timed-out filesystem sync fatal to a checkpoint.
  The existing best-effort native-suspension sync is unchanged.
- `prepareHostedEnvironment` accepts a trusted already-consumed checkpoint. It preserves workspace
  bytes and sandbox identity, skips workspace input/package/setup materialization, and retains the
  system-package installation step. Existing preparation remains unchanged without that receipt.
- Ordinary environment status/readiness/replacement operations cannot overwrite pending handoffs;
  snapshot leases fence retirement. Unexpected worker replacement without a handoff clears the old
  generation binding and retains the existing reset path.

### Native activation prerequisite

Inspection of the pinned source found that App Server stdio closure reaches
`processor.shutdown_threads()`, whose `ThreadProcessor::shutdown_threads` uses
`shutdown_all_threads_bounded(Duration::from_secs(10))`. Submission failures and timed-out threads
are logged while the process continues exiting. Background-task drain also logs timeout and
proceeds. Neither a zero exit code nor an observed process exit constitutes successful durable
conversation flush. The current `CodexRpcClient.close()` additionally escalates SIGTERM to SIGKILL.

M1b must add a positive native per-thread flush/shutdown acknowledgement, verify it against the
patched Linux ARM64 artifact, and integrate the host completion/admission barrier, all guest writer
termination, persistent-mount validation and strict sync. Then wire successor admission/claim before
any workspace writer starts, including repository preparation. Add a durable recovery sweep and
perform the real replacement proof: same files and native thread, no setup rerun, unchanged reset
count, old-worker fencing, and failure recovery. Production activation stays off until then.

### Validation scope and evidence

- Targeted local tests exercise concurrent claims, lost commit/adoption/publication acknowledgements,
  generation/owner fencing, lease expiry, retirement conflicts, consumed-permit crash recovery,
  failure at every handoff port, incomplete/forced native acknowledgement, strict-sync failures and
  filesystem adoption without setup rerun.
- Live `tests/aws/workspace-handoff.test.ts` passed using real `DynamoAgentsStore`, DynamoDB
  transactions and encrypted S3 content. Four competing adopters produced one successful claim and
  three rejected claims. Snapshot records remained after source-record deletion.
- The live proof creates no MicroVM or EC2 worker and does not claim native shutdown, physical
  snapshot copying or real worker replacement. Its temporary table and bucket were both deleted
  and independently checked absent by the harness.
- Live evidence: `.aws-e2e/rat-checkpoint-proof-8d5b897c-7f6e-45d6-876c-9e7c3d88a2b6/proof.json`.

Final M1a repository verification: `npm run check` passed with Terraform 1.15.8 (1,184 tests passed, 54 intentional skips, architecture/schema/routes/types, packaging and Terraform validation). `npm run smoke:local` and `git diff --check` passed. Logs are saved beside the live proof.

## M1b implementation — native acknowledgement and worker replacement

The private checkpoint path is now wired behind `session_checkpoints_enabled=false` by default.
Activation requires S3 Files and the matching native artifact. The flag travels only through the
trusted worker launch envelope; it does not add a public Agents API operation.

- `checkpoint-shutdown.patch` adds `thread/checkpoint`. Core shutdown records whether durable
  thread persistence actually succeeded. The protocol returns success only after that shutdown
  and the Session loop have ended. The host requires acknowledgements for every loaded thread,
  rejects newly appearing threads, and also requires a clean App Server process exit.
  A bounded native history read before shutdown refuses an unmaterialized empty root without
  closing it; post-acknowledgement reads verify that each stopped thread still has readable history.
- Session control shares one admission gate for Turn input, tool responses and live file writes.
  The runtime holds Run completion across native exit until the writer, journal, strict sync and
  commit barriers finish. Once durable transition admission is attempted, failures end the worker
  with no new reusable permit; lost commit acknowledgements retain an already committed permit.
- The worker closes credential/MCP refresh services and terminates every process belonging to
  the isolated guest UID. Journal artifact capture drains before a final writer check and strict
  filesystem sync. Post-checkpoint finalization does not clear persistent scratch directories.
- The lifecycle supervisor mounts and verifies S3 Files before launch, but defers all directory,
  configuration and transient bind preparation until the trusted runner claims workspace authority.
  Adoption verifies immutable setup/policy digests and the resolved execution envelope, consumes
  the permit, and requires native resume of its exact root thread. Missing history fails closed.
  Checkpoint-enabled worker exit always terminates its MicroVM, including failed handoffs; a
  persistent lifecycle server must not retain an empty worker after that generation ends.
  Setup commands inherit the worker-local SQLite location just like the main native harness.
- Durable input retry performs abandoned-transition recovery after positive termination of the
  exact source Run/generation. This replaces the proposed standalone recovery sweep for M1b:
  no worker is retained by an abandoned handoff, and recovery is required only before the next
  writer starts. A committed checkpoint is never cleared by expiry. Consumed permits cannot be
  reused after a crash. Replacement reservation is released only when its Run is terminal.
  Workers that die before beginning a handoff also require positive termination evidence. The
  inspected Run/generation fences the subsequent admission write against concurrent replacements.
- The live harness `tests/aws/session-checkpoint.test.ts` exercises two successive replacements,
  then an uncheckpointed crash of a consumed successor. The success path checks native context,
  modified declared inputs, one-time setup, sandbox identity and unchanged reset count. The crash
  path must discard the consumed permit and use normal workspace reset accounting.

### Live validation — 2026-10-11

The unassisted `tests/aws/session-checkpoint.test.ts` proof passed in 77.25 seconds on disposable
deployment `cp261011b`, account `731841023867`, region `us-west-2`, MicroVM image
`arn:aws:lambda:us-west-2:731841023867:microvm-image:rat-things-cp261011b-agent`, version `3.0`.
The test used the real native ARM64 runtime and model, private authenticated worker control,
DynamoDB, encrypted S3 and S3 Files. No manual worker termination assisted the checkpoint path.

- Session: `sess_be52be9444444409af3c0993516363c5`.
- Native root stayed `01a12d25-58d2-7750-910b-e754f787d86c` through two replacements.
- Both sources acknowledged native persistence, committed their handoff, finished successfully
  and reached physical `TERMINATED` automatically before their replacements started.
- Both successors recalled the exact random conversation marker, preserved modified declared
  input bytes, and retained sandbox `ee314f84-d903-42f9-b67b-e31436add4b2` with reset count zero.
  The setup counter remained six bytes, proving the append command ran only once.
- The harness then terminated the consumed successor without another checkpoint. Reconciliation
  and the next durable input recovered through the normal reset path: original declared input,
  a new sandbox, no reusable handoff, and reset count exactly one.

Live validation exposed two integration gaps that are now fixed: setup commands omitted
`CODEX_SQLITE_HOME`, leaving database locks on S3 Files, and the persistent supervisor retained
an empty VM after checkpoint completion. A real native setup regression test covers database
placement. An earlier diagnostic replacement run required explicit source termination and is
marked assisted in its evidence; it is not the final proof. The fixture now calls its random
conversation value a harmless test marker, avoiding a model refusal caused by calling it a secret.

Native compilation used disposable ARM CodeBuild project `rat-checkpoint-build-98fbb81397` because
local Docker was unavailable. Artifact SHA-256 is
`0314d5ccb16a9ef5dc21704078076898328b1b96730299f19d5cf4ae160488d5`, pinned to the existing upstream
revision plus the five declared patches. Its clean Linux initialization smoke also passed. The
build project, IAM role/policy and S3 bucket were deleted and independently verified absent.
Manifests and native build/smoke logs remain under its matching `.aws-e2e/` directory.

Final repository verification: `npm run check` passed (1,223 tests passed, 55 intentional skips,
architecture/schema/routes/types, packaging, site and Terraform validation). `npm run smoke:local`
passed. Live proof and logs are under `.aws-e2e/cp261011b/`: `checkpoint-proof.json`,
`live-passing.log`, `check-passing.log`, `worker-evidence.log` and `worker-cleanup.json`.
All twelve workers from the successful and diagnostic attempts were independently confirmed
`TERMINATED`. Terraform destroyed all 269 disposable stack resources and retains no managed
resources. Its tag audit flagged a stale subnet entry; direct EC2 inspection confirmed that subnet
is absent. Independent checks resolved every remaining tag to an absent/deleted resource or the
scheduled KMS key deletion. Evidence is in `stack-cleanup.log` and `cleanup-proof.json`.

M1 is complete. Activation remains off by default. M2 adds EC2 idle and MicroVM lifetime/retention
triggers; it does not need another native flush prerequisite. No automatic idle policy, physical
snapshot copier, fork API or preview relay is included in M1b.


## M3 implementation and validation

The explicit fork path depends on M1, without waiting for automatic idle policies in M2.
The API holds source mutation admission, checkpoints a live source, reserves a five-minute
snapshot lease, and prepares a child using pinned setup inputs and fresh credential references.
The first child worker copies the source with directory-handle-relative, no-follow filesystem
operations; publishes a synced immutable snapshot; then creates its own mutable copy.
Successful publication releases source admission. Native fork initialization creates a new root
thread through the captured native Turn. Private pre-fork recovery Items are stored in the child's
encrypted Session definition. Partial copy failures remove files created by that copy. Temporary
snapshot objects have a seven-day lifecycle, separate from mutable Session data.

The local native test verifies moved CODEX_HOME paths, a bounded Turn cut, a new native identity,
retained function definitions, and a narrower effective sandbox. Native attachment emits inherited
usage notifications; fork initialization excludes those from public child Turns. Agent instructions
and tool definitions remain pinned to the source; v1 does not offer tool or instruction overrides.
The full repository check passed 1,238 tests (56 intentional skips), including packaging,
architecture/schema/routes/types, site and Terraform validation. The local smoke test passed.
Additional regression checks cover a worker lost during initial copying and replacement before
a fork has its first new Turn. The latter retains inherited native Turn IDs in the private runtime
journal so delayed attachment events cannot create public source Turns or charge their usage
to the child.

The final AWS Linux ARM64 scenario passed on image 4.0: three independent forks, inherited
files and conversation, setup preserved exactly once, and file isolation in both directions.
A child created without input was checkpointed and replaced before its first new Turn; its
native identity survived and its public timeline contained exactly one new Turn. The source
resumed with its original identity and workspace. After source deletion, a subsequent child worker
replacement retained the pre-fork conversation. A preceding diagnostic run exposed only an
ambiguous test prompt (it asked to read a file but asserted that the answer printed it); the final
harness explicitly requests the contents. No manual state repair was used in the passing run.

Evidence is under `.aws-e2e/fork261011a/`: `fork-proof.json`, `live-passing.log`,
`check-passing.log`, `smoke.log` and `worker-cleanup.json`. All 19 workers across passing and
diagnostic attempts were independently confirmed `TERMINATED`. Terraform destroyed all 271
disposable stack resources; no managed resources remain. The tagged-resource audit passed;
the KMS key is disabled and scheduled for deletion. Cleanup evidence is in `stack-cleanup.log`
and `cleanup-proof.json`. Activation remains off by default. The v1 copy limit is 256 MiB; larger-workspace
benchmarking, empty source Sessions, and automatic M2 policy triggers remain separate work.

## Fork studio demo and publication

The documentation site now includes a two-theme interactive walkthrough at `/fork-demo/`.
`npm run demo:fork` serves it locally; `--live` connects the same UI to a real deployment.
The live controller prepares a Fieldnotes Session, forks warm editorial and dark electric
variations, renders their saved HTML artifacts, deletes the unchosen child, and retains the
winner and original. A local resource inventory survives server restarts and supports cleanup
of partial runs. The browser never receives AWS or API credentials. Preview frames prevent
scripts, external assets and link navigation; downloads preserve the generated HTML bytes.

Repository validation passed 1,244 tests with 56 intentional skips, including the managed
startup regression: a transient `environment_connection` action must wait for worker startup.
The website browser suite passed 32 tests, covering both choices, reset, download, mobile,
keyboard use, missing live-server handling, and preview isolation. Visual inspection covered
both real generated themes and the desktop/mobile walkthrough. Screenshots must wait for
frame painting after scrolling; checking text alone does not prove an embedded preview painted.

The live browser scenario in disposable deployment `fd261011a` generated both themes from one
source. Selecting After hours left the source and winner readable (200), while Paper & ink
returned 404. Reload retained the choice; a browser download matched the winning artifact
byte for byte. UI cleanup removed all three Sessions and the demo Agent (all returned 404).
Five workers, including the initial startup diagnostic attempt, were confirmed terminated.
Evidence and generated HTML are retained under `.aws-e2e/fd261011a/`: `demo-proof.json`,
`live-browser.log`, `live-chosen.png`, `paper.html`, `midnight.html`, `site-browser-final.log`,
`check-commit.log` and `worker-cleanup.json`.
Terraform removed all 271 disposable demo-stack resources; no managed resources remain.
The resource-tag audit passed, with the KMS key disabled and scheduled for deletion.
`stack-cleanup.log` and `cleanup-proof.json` record the final audit. Checkpoint/fork activation
remains off by default in deployable configuration.
