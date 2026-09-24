# Lambda MicroVM image source

`npm run package` builds `dist/microvm-source.zip` with this directory plus the bundled
`runner.mjs`, the verified Linux ARM64 Codex runtime, Codex configuration, and Git askpass helper.
Build the native artifact using `testing/README.md` before packaging; the image never falls back to
the stock binary. AWS Lambda MicroVMs consumes that S3 ZIP,
runs the Dockerfile, starts the lifecycle server, and snapshots the initialized process tree.

The lifecycle server and trusted `runner.mjs` run as root because orchestration needs mount/process
authority and the MicroVM execution role for DynamoDB, S3, and narrowly scoped Secrets Manager
reads. The runner starts Codex and the Chromium helper as UID/GID 10001 with sanitized environments.
Codex receives no execution-role credential-chain variables; Chromium receives no AWS or integration
credential variables at all. Integration tokens remain transient inside the trusted runner and are
passed directly to a fixed-origin adapter only after the fixed provider/grant/profile/resource
authorization succeeds.

Never change the image entrypoint to the `agent` user: doing so breaks trusted orchestration. Never
remove the Codex/browser UID drop or pass the runner's credential environment to either child: doing
so defeats the host/model separation inside the MicroVM.

`browser-host.mjs` is an IPC-only Chromium helper for public-web navigation and bounded interaction.
It can retain PNG/JPEG screenshots and VP8 WebM recordings only below the runner-provided artifact
root. Paths reject traversal and symbolic-link escapes; full-page height, recording duration, frame
count, frame rate, and encoded bytes are capped. Recordings finalize to an exact in-memory encoder
result before an atomic `0600` rename, avoiding malformed EBML from the encoder's positional-file
backend. The helper receives neither AWS credential variables nor integration credentials.

The `/run` hook accepts the service wrapper `{ microvmId, runHookPayload }`. The nested payload is
versioned and contains only run IDs, S3/DynamoDB references, bounded configuration, and (optionally)
a Secrets Manager ARN. Prompts and credential values are never hook payload fields. In default
ChatGPT mode, trusted orchestration materializes a validated mode-`0600` `auth.json` inside
`CODEX_HOME`, persists refresh rotation to the secret, and deletes the runtime copy. Codex and
repository code share UID 10001 and can read the active file, so this is an explicitly accepted risk
for trusted agents—not an untrusted-tenant boundary. A run reads its input from encrypted S3 after
the MicroVM receives fresh run-time credentials.

After a private Session worker exits, the lifecycle server launches the separately
bundled `terminate-microvm.mjs`. A Session harness remains available for additional
Turns through authenticated control. Native state belongs to the Session runtime
journal. When S3 Files is enabled, `sessionStorageKey` selects the same owner-and-Session
hashed directory across replacements; `SESSION_STATE_ROOT` supplies its workspace
and Codex home. Hosted sandbox replacement clears workspace contents while retaining
the native conversation checkpoint. Keep the existing hash and filesystem root stable.

Lifecycle endpoints listen on port 8080 under
`/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`.
AWS invokes these hooks, including storage synchronization on suspend and mount
validation on resume. The retired endpoint that posted another Run into a
conversation MicroVM is removed. Current private control routes operate on the
exact supervised harness and accept Session Turn input.

Individual MicroVMs are launched by the dispatcher and have a bounded service
lifetime. Saved Session history and artifacts outlive compute. An idle policy
can explicitly bound idle lifetime; connected Sessions otherwise keep their harness.
The opt-in dedicated EC2 supervisor uses host-managed lifetime and terminates the
instance when execution authority ends. Its lifecycle listener is loopback-only.

A cgroup eBPF connect policy denies UID 10001 access to TCP port 8080 when the destination is
loopback, unspecified, or one of the guest's own IPv4/IPv6 interface addresses. That prevents Codex
or Chromium from calling the lifecycle/control plane or mutating their own capability envelope while still
allowing the root-owned Lambda loopback proxy and unrelated external services that happen to use
port 8080. The policy is installed and verified before the listener starts and validated again at
the snapshot hook. External control requests still cross Lambda's port-scoped JWE-authenticated
ingress endpoint; Lambda removes its reserved proxy headers before forwarding them to the listener.

Rat Things has no mid-Run approval path. The runner pins Codex App Server to `approvalPolicy:
"never"`; an unexpected command/file approval request fails closed. Every tool exposed to UID 10001
has already been admitted by the capability profile, Agent and Session configuration, IAM, network policy,
provider scopes, and connection grants. `danger-full-access` is broad guest access, not permission
to escape those outer boundaries.
