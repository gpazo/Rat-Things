# Security and threat model

## Security posture

Treat prompts, webhook fields, repositories, tool results and model output as untrusted.
A valid provider signature authenticates the delivery; it does not make its author or content
trustworthy. Rat Things owns the API, harness, state and workers in the operator's AWS account.

A managed Session uses a dedicated worker VM. Workspaces and execution identities are isolated
by owner and Session. The native sandbox is additional protection; the outer VM is the primary
execution boundary. Trusted orchestration runs as root and launches Codex, repository commands
and Chromium as UID/GID 10001. Local CLI execution has a separate read-only/no-network default.

The EC2 worker supports connected Session lifetime beyond Lambda MicroVM's maximum lifetime.
Both backends must preserve the same ownership, process and credential boundaries. Self-hosted
executor connections also require an operator-controlled sandbox; transport encryption does
not make a shared or privileged executor safe.

## Protected assets

- AWS resources, worker roles and model credentials.
- Provider signing secrets, clone tokens, delivery tokens and OAuth refresh tokens.
- Vault credentials and environment variables deliberately installed into a sandbox.
- Private source, prompts, native journals, workspace files, Items and saved artifacts.
- Provider destinations, model budget and execution capacity.

## Trust boundaries

```text
API caller -> authenticated HTTPS API -> durable Session state and outbox
Provider   -> signature verification -> owned source binding -> Session input
                                                     |
                                               private dispatch
                                                     |
                                          dedicated worker + harness
                                                     |
                                          durable Turns and Items
                                                     |
                                     delivery adapters -> provider APIs
```

The authenticated API principal owns its resources. A provider event supplies attribution and
source metadata; the preconfigured source binding selects the operator owner and Agent. Generic
source selectors are trusted operator configuration, not proof that an arbitrary tenant owns a
repository or channel. Destination selection and credential-subject selection remain separate
from actor attribution. No caller-provided URL or credential may establish ownership.

## Threats and controls

| Threat | Present control | Boundary or remaining concern |
| --- | --- | --- |
| Forged webhook | Verify the exact raw body before parsing; provider-specific signature and timestamp rules | Rotate authenticators and restrict accepted event types; see [channels](channels.md) |
| Duplicate ingress | Owner/binding-scoped input receipts and conditional commits | Retention bounds deduplication; do not treat a trigger mention as authorization |
| Cross-owner access | Owner-scoped resources, hashed storage prefixes and authenticated lookups | Review authorizer/tenant mapping and deployment IAM independently |
| Malicious repository | Dedicated VM, argument-array commands, HTTPS host allowlist and unprivileged checkout commands | Native tools can exercise all admitted authority; same-UID model/environment credentials are readable by repository code |
| Guest reaches control plane | Root-owned listener/configuration, guest UID split and cgroup eBPF local-port denial | A root/kernel escape compromises the worker boundary |
| Guest steals AWS role | Sanitized child environment and metadata denial on EC2 | Keep the explicit AWS credential-chain escape hatch disabled |
| MCP or function abuse | Explicit tool declarations, credential selection, transport policy and fail-closed approval handling | Environment tools and environment credentials share the admitted sandbox authority |
| Credential confused deputy | Distinct owner, actor, source, destination and credential subject; broker checks before secret reads | Trusted adapters and the service role remain authoritative |
| OAuth replay or account swap | Hashed one-use state, PKCE, owner binding, verified provider identity and serialized refresh | Reconnection must preserve the expected tenant/subject; provider consent is an external boundary |
| Browser SSRF | Unprivileged helper, URL/DNS checks, blocked private/link-local destinations and redirects | Public relay sites, DNS rebinding and browser vulnerabilities require deployment egress controls |
| Duplicate external write | Durable delivery fences and explicit unknown-outcome state | Reconcile ambiguous provider acceptance; never automatically replay it merely because an acknowledgement was lost |
| Lost Session event | Durable journal/event commits and an outbox separate from delivery effects | Outbox failures and expired retries need operator reconciliation |
| Superseded worker write | Immutable execution generation, backend identity and conditional state changes | Lost process memory cannot be recreated from public Items alone |
| Artifact disclosure | Private encrypted objects, owner checks, saved Turn/path identity and explicit publication grants | Publication URLs are bearer credentials; provider copies have independent retention |
| Resource exhaustion | Bounded requests, pagination, queues and deployment concurrency controls | Configure tenant budgets, API throttles and provider-event abuse limits |
| Supply-chain compromise | Locked packages, pinned source/base image, recorded patches and artifact digests | Review build provenance and scan/sign release artifacts |

## Fixed capability-envelope security model

The Session retains its resolved Agent configuration. Tools and environments are admitted before
execution and cannot be widened through a native approval request. Codex uses
`approvalPolicy: "never"`; approval-shaped requests fail closed. Missing tools, IAM denials,
broker rejection and blocked network destinations remain failures, not pending authorization.

Connection installation, OAuth initiation, identity replacement, grants and source-binding
management are owner-authenticated operator actions. They are not automatically exposed as
model tools. Notification connection sets do not imply Agent tool access. A host can explicitly
provide a function or MCP service backed by an appropriate broker, with a separately reviewed
capability envelope. See [the capability envelope](capability-envelope.md).

## IAM separation

Keep these roles distinct:

1. Token issuance authenticates callers without provider-administration authority.
2. The HTTPS API reads/writes canonical resources and dispatches through durable state. Its
   policy is separate from provider control and the outbox.
3. Ingress validates provider credentials and records normalized inputs under source bindings.
4. The outbox performs admitted execution, scheduling, webhook and terminal-delivery effects.
5. Dispatch launches the selected worker backend under constrained launch/pass-role permissions.
6. The trusted worker reads its runtime inputs and selected secrets, updates fenced execution
   state and writes Session files/journals. The guest receives only explicitly admitted model
   and environment credentials.
7. Delivery reads the saved terminal Turn and credentials for its destination. It does not
   execute model-generated commands or clone repositories.

The EC2 backend has no inbound worker security-group rules. A private durable command mailbox
carries control requests, and each claim precedes its effect. An uncertain acknowledgement does
not authorize replay. Commands are fenced to their intended public Turn and execution generation.

Lambda MicroVM control uses AWS-issued port-scoped proxy tokens. Keep those tokens inside trusted
orchestration. Its root listener permits the service proxy while the guest-local cgroup policy
denies UID 10001 access to port 8080. Neither transport exposes an authority-widening guest route.

Scope Secrets Manager ARNs, storage prefixes, launch templates, image inputs and `iam:PassRole`.
Worker role permissions are broader than one Session's object prefix, so the root boundary is
material. The agent must not inherit that role's full credential chain.

## Secret handling

Store values in Secrets Manager; public configuration uses resource IDs or approved references.
Never place tokens in prompts, clone URLs, DynamoDB records, task overrides or logs. Keep webhook,
clone, model, Vault and delivery identities distinct. A Workflow URL is a credential.

Service-side MCP credentials stay in the service process. A Vault `environment_variable`
credential supplies a placeholder to a hosted sandbox. The trusted host substitutes its secret
in HTTPS headers only for the credential's exact allowed hosts on port 443 or 8443, within the
environment's network policy. TLS verification and public-address checks precede each outbound
request. Raw values and certificate private keys remain outside the guest UID. A Session keeps
its credential snapshot across Vault rotation; new Sessions use the replacement value.

Plain environment values and inline environment MCP variables can be read by sandbox code.
Use Vault placeholders for outbound API authentication when the sandbox should not read the
secret or use it for local computation.

With `CODEX_AUTH_MODE=chatgpt`, trusted orchestration reads the selected encrypted file-based login,
materializes a private `auth.json`, persists validated refresh rotation and removes the runtime
copy during cleanup. Only the approved secret reference crosses orchestration. A persistent
Session may retain the credential while its harness is active.

Codex must read that file, so malicious same-UID code can steal its bearer and renewable refresh
tokens. The bundle excludes the password and MFA secret but still permits account impersonation
and Codex usage. Use the bridge only for trusted owner-operated workloads, and use account-session
revocation plus secret removal when a credential is compromised. Encrypted backing storage does
not remove the active-process risk.

Bedrock is an explicit provider choice. Trusted orchestration mints a bounded bearer token from
its AWS identity or reads the configured token secret. Keep `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN`
false unless exposing the entire role is intentional. The requested model identifier must retain
its meaning; a substitute provider/model is not a compatibility repair.

Keep model credentials out of image builds, test logs and diagnostic output. See
[Codex subscription setup](codex-subscription.md) for the file bridge and its lifecycle.

## Storage and retention

Prompts, journals and artifacts live in encrypted S3. DynamoDB stores resource state, references
and bounded summaries. Owner checks remain required even when an object outlives its database
record. Saved artifacts are immutable per Turn/path; publishing creates a separate explicit
grant. Artifact deletion and workspace-file deletion are distinct operations.

DynamoDB TTL is asynchronous. S3 lifecycle, event retry windows, CloudWatch retention and provider
copies have separate lifetimes. Align them with the operator's retention policy.

Retired Thing/Routine/conversation data remains declared at its existing Terraform addresses for
explicit disposition. It is not executable through the new API. Existing TTL and queue expiry
still apply; retaining resource definitions is not an archival guarantee. The historically named
S3 Files resources remain active Session storage and must not be removed with retired data.

## Repository and process isolation

Accept only allowlisted credential-free HTTPS repository URLs. Commands use argument arrays;
trusted orchestration never interpolates a prompt, URL, ref or path into a shell command.
Repository-controlled Git configuration and commands execute as UID 10001.

Workspace paths are anchored beneath the configured root. A replacement worker may reuse only
the same owner/Session storage under its fenced execution identity. Native checkpoints preserve
harness history; public-item recovery preserves historical facts without replaying tool effects.
Neither recovery path promises survival of a process whose VM has been destroyed.

The EC2 supervisor requires the outer dedicated VM for its privileged mount/network setup. The
agent does not receive the Docker socket or host control configuration. Metadata and the local
control listener are denied to the guest while trusted root orchestration remains able to operate.

## MicroVM-specific review

Lambda MicroVM snapshots must contain only generic initialization. Supply Session identity,
credentials and runtime clients during launch, not image build. Keep launch hooks within the
service payload limit and keep worker proxy tokens in trusted orchestration.

S3 Files mounting and the local control-port guard require privileged in-VM setup. The agent
still runs as UID 10001. Suspended memory and disk are sensitive Session state and remain subject
to configured expiry and explicit teardown. Lambda MicroVM lifetime is bounded; select the EC2
backend for connected-process requirements beyond that bound.

## Production security gates

Deployment review must cover IAM/pass-role scope, authorizer ownership, guest credential and
metadata isolation, outbound network policy, replay/unknown-outcome handling, budget limits and
artifact access. Test cancellation, worker replacement, prompt injection, malicious repositories,
SSRF, cross-owner access and real provider payloads. Keep release provenance and secret rotation
procedures current. Local conformance fixtures do not establish these deployed guarantees.
