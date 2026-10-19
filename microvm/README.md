# Lambda MicroVM image source

`npm run package` builds `dist/microvm-source.zip` with this directory plus the bundled
`runner.mjs`, the pinned `pi-child.mjs`, the verified Linux ARM64 Codex runtime, Codex configuration, and Git askpass helper.
Build the native artifact using `testing/README.md` before packaging; the image never falls back to
the stock binary. AWS Lambda MicroVMs consumes that S3 ZIP,
runs the Dockerfile, starts the lifecycle server, and snapshots the initialized process tree.

The lifecycle server and trusted `runner.mjs` run as root because orchestration needs mount/process
authority and the MicroVM execution role for DynamoDB, S3, and narrowly scoped Secrets Manager
reads. The runner starts the selected Codex or Pi Durable process as UID/GID 10001
with a sanitized environment. Codex receives no execution-role credential-chain variables
by default; `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=true` explicitly exposes them. The Pi child
uses a separate restricted environment and does not inherit those variables.
Integration tokens remain transient inside the trusted runner and are
passed directly to a fixed-origin adapter only after the fixed provider/grant/profile/resource
authorization succeeds.

Never change the image entrypoint to the `agent` user: doing so breaks trusted orchestration. Never
remove the agent UID drop or pass the runner's credential environment to the child: doing
so defeats the host/model separation inside the MicroVM.

The `/run` hook accepts the service wrapper `{ microvmId, runHookPayload }`. The nested payload is
versioned and contains only run IDs, S3/DynamoDB references, bounded configuration, and (optionally)
a Secrets Manager ARN. Prompts and credential values are never hook payload fields. In default
Codex ChatGPT mode, trusted orchestration materializes a validated mode-`0600` `auth.json` inside
`CODEX_HOME`, persists refresh rotation to the secret, and deletes the runtime copy. Codex and
repository code share UID 10001 and can read the active file, so this is an explicitly accepted risk
for trusted agents—not an untrusted-tenant boundary. A run reads its input from encrypted S3 after
the MicroVM receives fresh run-time credentials.

Pi Durable uses the bundled `pi-child.mjs` and approved Bedrock Converse models.
The trusted host supplies short-term inference tokens and acknowledges native
commits before the child applies them. Pi native state uses the Session state
store; managed Pi workspace recovery requires S3 Files and Session checkpoints.
See [agent runtimes](../docs/agent-runtimes.md) for selection and recovery boundaries.

A Session harness remains available for additional Turns through authenticated
control. With checkpointing enabled, any exit of that worker launches the separately
bundled `terminate-microvm.mjs`, including failed handoffs; replacement requires a new
worker generation. Native state belongs to the Session runtime
journal. When S3 Files is enabled, `sessionStorageKey` selects the same owner-and-Session
hashed directory across replacements; `SESSION_STATE_ROOT` supplies its workspace
and Codex home where applicable. Without a committed workspace handoff, Codex replacement
resets the workspace and restores available conversation state. With checkpointing enabled,
it can adopt a committed handoff before preparing the workspace. Pi managed recovery retains
flushed workspace files after verified worker termination. Keep the hash and filesystem root stable.

Lifecycle endpoints listen on port 8080 under
`/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`.
AWS invokes these hooks, including storage synchronization on suspend and mount
validation on resume. Before acknowledging resume, the supervisor records the
active Run's resume timestamp and includes it in the generation-checked health
response. Reconciliation measures keep-alive age from the later of that timestamp
and the durable heartbeat. A suspended VM is inspected through AWS state without
a proxy request. Deploy the lifecycle image and reconciler together for this
resume protection; older images do not supply resume evidence. Environment keep-alives retry
transient storage failures after thawing, but stop after three consecutive failures or immediately
on confirmed loss of environment authority.
The retired endpoint that posted another Run into a
conversation MicroVM is removed. Current private control routes operate on the
exact supervised harness and accept Session Turn input.

With `session_checkpoints_enabled`, the private `checkpoint` route seals Session input and live
file operations, obtains explicit native persistence acknowledgements, stops guest writers,
drains the journal and strictly syncs S3 Files before committing a handoff. Native process exit
alone is insufficient. Replacement workers defer even host-side workspace preparation until
they have consumed the handoff or bound a fresh execution generation. The flag defaults to false
and requires S3 Files plus the matching patched native artifact. It does not schedule idle
hibernation or expose worker ingress to guests or applications.

Individual MicroVMs are launched by the dispatcher and have a bounded service
lifetime. Saved Session history and artifacts outlive compute. An idle policy
can explicitly bound idle lifetime; connected Sessions otherwise keep their harness.
The opt-in dedicated EC2 supervisor uses host-managed lifetime and terminates the
instance when execution authority ends. Its lifecycle listener is loopback-only.
The scheduled reconciler also retires dedicated workers whose matching Run has
been terminal for at least two minutes, so a blocked guest or storage shutdown
cannot retain compute indefinitely. It verifies deployment, launch template,
Run, instance and generation, and leaves missing or active authority untouched.

A cgroup eBPF connect policy denies UID 10001 access to TCP port 8080 when the destination is
loopback, unspecified, or one of the guest's own IPv4/IPv6 interface addresses. That prevents the agent process
from calling the lifecycle/control plane or mutating its own capability envelope while still
allowing the root-owned Lambda loopback proxy and unrelated external services that happen to use
port 8080. The policy is installed and verified before the listener starts and validated again at
the snapshot hook. External control requests still cross Lambda's port-scoped JWE-authenticated
ingress endpoint; Lambda removes its reserved proxy headers before forwarding them to the listener.

Rat Things has no mid-Run approval path. The runner pins Codex App Server to `approvalPolicy:
"never"`; an unexpected command/file approval request fails closed. Every tool exposed to UID 10001
has already been admitted by the capability profile, Agent and Session configuration, IAM, network policy,
provider scopes, and connection grants. `danger-full-access` is broad guest access, not permission
to escape those outer boundaries.
