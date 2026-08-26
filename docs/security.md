# Security and threat model

## Security posture

Treat every prompt, webhook field, repository byte, branch name, agent event, and model response as
untrusted. A successful provider signature proves that the provider sent the request; it does not
make the author, repository, prompt, or generated commands trustworthy.

The outer Lambda MicroVM is the primary code-execution boundary. A VM is scoped either to one
one-shot run or to one authenticated conversation session; it is never shared across owners or
conversation IDs. The agent CLI's `read-only` or `workspace-write` sandbox is useful defense in
depth, not the tenant-isolation boundary. This repository is an engineering preview and has not yet
completed the controls marked “required before production” below.

Remote MicroVM execution accepts and defaults to `danger-full-access` with command networking
enabled. This is deliberate: the dedicated MicroVM, UID/environment split, workload IAM role, and
credential broker are the security boundary, while Codex's inner sandbox is a selectable
defense-in-depth control. Trusted local execution keeps a read-only/no-network default. Deployments
can remove modes from `ALLOWED_SANDBOX_MODES`, and profiles/requests can narrow authority, but no
request can widen the deployment or profile ceiling.

## Protected assets

- AWS account resources and the worker/model IAM roles.
- Webhook authenticators, source-control tokens, Teams Workflow URLs, and Slack tokens.
- Connected-account credentials, provider scopes, Rat-side grants, and source bindings.
- Private repository content and any material generated in the workspace.
- Prompts, model events, results, patches, and owner/source metadata.
- Provider threads and chat destinations the notifier can write to.
- Compute/model budget and queue capacity.

## Trust boundaries

```text
Internet/provider
  |  untrusted bytes
  v
API Gateway -> signature/authentication Lambda -> durable AWS control plane
                                                   |
                                                   | run ID + resource coordinates
                                                   v
                                          isolated MicroVM
                                                   |
                                                   | untrusted generated output
                                                   v
                                         notification adapters -> provider APIs
```

Authentication, normalization, execution, and delivery are separate boundaries. In particular:

- **Actor attribution** comes from the authenticated API principal or verified provider event and is
  retained as bounded run provenance; attribution alone grants no authority.
- **Owner identity** comes only from API Gateway authentication or a verified provider event.
- **Source identity** is created only by the API transport or an authenticated provider plugin.
- **Destination identity** comes from trusted normalized source metadata or a deployment-controlled
  route map.
- **Credential-subject identity** is explicit (`actor` or deployment `runtime`) before a host-owned
  credential is considered. Actual credential authority comes from an IAM role or an allowlisted
  Secrets Manager ARN.

Never let a source field select an owner, a destination route contain a credential, or a credential
grant ownership. The general control API overwrites caller-supplied source metadata by design.

## Threats and controls

| Threat | Present control | Residual risk / required production work |
| --- | --- | --- |
| Forged webhook | Exact raw-body GitHub HMAC; GitLab 19 Standard Webhooks HMAC with ID, five-minute timestamp window, and downgrade-resistant legacy fallback; Teams HMAC; Slack HMAC plus five-minute skew | Prefer GitLab signing tokens over legacy `X-Gitlab-Token`, rotate secrets, isolate environments, alarm on signature failures, and treat source IP only as an optional extra—not an authentication replacement |
| Replay/duplicate delivery | Provider event IDs become owner-scoped idempotency keys; conditional run insert and transitions | Idempotency expires with the run; establish a longer replay ledger if the business requires it |
| Caller impersonates owner/source | API Gateway principal derives owner; API source overwritten; webhook source built only after verification | Terraform authorizer policy and tenant mapping need an explicit production review |
| Prompt injection / malicious repository | Per-run MicroVM with no user-facing workload ingress, restricted Git URL/ref validation, commands use argument arrays, mention-gated comments, webhook review defaults to read-only | Assume injection wins. Restrict the execution role and egress, prevent writes to source providers, and add policy gates for tools and destinations; a trigger mention is not authorization |
| Repository credential theft | Trusted root orchestration fetches the secret, exposes it only to Git through `GIT_ASKPASS`, then chowns the checkout to UID 10001; the agent child does not receive the token or root environment | Use short-lived installation tokens, restrict selectable secret ARNs, test `/proc`/metadata isolation, and consider a dedicated clone broker for stronger separation |
| SSRF / arbitrary checkout | Credential-free HTTPS and hostname allowlist; no query/fragment | Validate redirect targets or disable cross-host redirects, restrict DNS/egress, and test alternate encodings. Submodule support must remain off unless separately secured |
| AWS credential abuse by agent | Agent runs as UID 10001 with a sanitized environment; AWS credential-chain variables are omitted unless `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=true`; preferred model auth passes only a scoped Bedrock bearer key | Process/environment separation is defense in depth, not a VM boundary. Keep the escape hatch false, test metadata/`/proc` access, scope the root workload role, and use network policy/proxies |
| Connected-account credential theft or confused deputy | Credential values live in per-connection Secrets Manager secrets; the model sees aliases/schemas only; provider authorization, persistent grants, profile ceilings, per-run narrowing, and resource constraints are intersected before one secret is read | Every exposed operation is autonomous: there is no human approval backstop. Coarse/full provider tokens retain upstream authority if the broker or trusted adapter is compromised. Prefer granular/short-lived tokens, constrain secret IAM, audit tool calls, and independently review every built-in adapter |
| Agent mutates its own capability envelope over the guest-local listener | Codex and Chromium run as UID 10001; a cgroup eBPF connect policy denies that UID access to guest-local TCP port 8080 while the root-owned Lambda proxy remains allowed, and external control still requires Lambda's JWE-authenticated endpoint. The public API has no authority-widening route | Treat a root/kernel, BPF-policy, or AWS proxy-auth bypass as a MicroVM compromise. Keep the UID split and exercise root acceptance, loopback/interface denial, and unrelated external-port-8080 acceptance in the ARM64 image canary |
| Cross-account integration mix-up | Credentials are verified before persistence; trusted plugins derive tenant/subject identity; connections, grants, sets, and credential pointers are owner-scoped; rotation must resolve to the same provider identity; every ambiguous dynamic tool call selects an exact eligible alias | Provider identity endpoints can be incomplete and plugin code is trusted. Review each verifier, prefer stable provider IDs over labels, and retain duplicate/ambiguous-account conformance tests |
| Unauthorized source-policy claim | Source selectors are matched only after webhook verification and a global conditional claim prevents duplicate exact bindings | The IAM management route does not yet prove provider ownership of a repository/team/channel selector. Restrict binding creation to a trusted self-hosted operator until provider installation/OAuth authorization is implemented |
| Browser SSRF or unsafe interaction | Separate unprivileged Chromium helper; loopback/private/link-local/metadata destinations and redirects blocked; popups/downloads rejected; DOM/images bounded; screenshots and recordings use validated artifact paths plus pixel/duration/frame/byte caps; browser/network access is either admitted before launch or absent | Admitted browser actions are autonomous. DNS rebinding, public relay endpoints, browser/Chromium vulnerabilities, and exfiltration to attacker-controlled public sites remain. The browser profile and Codex share UID 10001, so browser cookies are not a secret boundary from the model. Do not type reusable credentials into the browser; prefer brokered integrations. Add an egress proxy/DNS policy, origin audit, and browser escape testing before sensitive production use |
| Model-output exfiltration or mention injection | Bounded notifier messages and explicit destinations | There is no output DLP, secret scan, mention escaping, or human approval. Do not post private-repo results to broad channels; add a policy/redaction layer before production |
| Network exfiltration | MicroVM isolation plus AWS-managed networking | Public egress is broad. Add an explicit proxy/allowlist or a reviewed customer VPC connector when production policy requires it; remember GitHub/GitLab endpoints have dynamic ranges |
| Queue/cost exhaustion | Bounded request fields, idempotency, asynchronous SQS, AWS concurrency controls | Configure API/WAF throttles, Lambda reserved concurrency, MicroVM quotas, SQS alarms/DLQ, tenant budgets, and mention/command gating |
| Duplicate or suppressed notification | Conditional per-destination fence; `sending` uses a 120-second reclaimable lease; EventBridge retries failed notifier invocations for up to 24 hours/185 attempts and then uses an encrypted, alarmed DLQ | `outcome_unknown` requires provider reconciliation. A crash after provider acceptance but before recording `delivered` can be reclaimed and posted twice; no fence can make an API without an idempotency key exactly once. Drill DLQ redrive and ambiguous outcomes |
| Self-triggering provider loop | GitHub/GitLab comments require a non-empty trigger; outbound source replies carry a hidden runtime marker; normalization ignores marked replies and provider-declared bot authors | Marker/bot checks prevent ordinary runtime reply loops, not malicious-author abuse. Test provider payload variations and cap per-owner/thread runs and model cost before production |
| Lost terminal notification event | DynamoDB Streams separates the state commit from EventBridge publication; the mapping retries ten times over a maximum 24-hour record age, then sends invocation metadata to an encrypted SQS failure queue with an alarm | Replay is manual, the failure item does not contain the full stream record, and DynamoDB Streams data expires. Drill sequence-range replay and current-run event reconstruction; consider a durable outbox if this recovery objective is insufficient |
| Dead or superseded execution mutates active state | Immutable execution generation plus MicroVM ID; worker start, heartbeat, stale failure, and cancellation settlement use conditional exact-identity writes; a root-owned endpoint proves the supervised Run/generation before repair | Heartbeat is a liveness control, not a defense against full MicroVM compromise. Ambiguous observations are quarantined for operator review, and lost Runs are never semantically replayed automatically |
| Artifact/publication disclosure | Private S3, checksums, owner-hashed prefixes, authenticated owner check, a public Run projection with no S3 coordinates or internal execution handles, bounded catalogs, strict agent publication declarations, unguessable grants, publication-specific hosts, host-only signed cookies, CloudFront OAC, and a legacy one-minute S3 redirect | Time-bounded artifact/share URLs remain bearer credentials. Add revocation, audit/rate limits, content scanning, and policy profiles before broader sharing |
| Supply-chain compromise | Locked npm dependencies and immutable reference-project pins | Pin container bases by digest, scan/sign images and bundles, generate SBOMs, protect CI provenance, and review MicroVM snapshots |
| Snapshot contamination | Run-specific data is supplied at `/run`, not intended for image build | Verify hooks never bake secrets, unique IDs, live sockets, or checkout state; follow AWS snapshot guidance on every image revision |

## Fixed capability-envelope security model

Rat Things has no mid-Run human authorization decision. Before MicroVM launch, the authenticated
owner/source, deployment profile, Run or Thing narrowing, execution-role IAM, network policy,
provider scopes, connection grants, operation rules, and resource constraints resolve to one fixed
envelope. The agent is assumed able to exercise every capability in that envelope autonomously.
Outside it, the relevant control fails closed: a tool is omitted, the credential broker rejects
before secret access, IAM returns `AccessDenied`, or browser/network policy blocks the destination.
None of those outcomes creates an approval that can be accepted for the active Run.

`danger-full-access` grants broad command/filesystem access inside that Run's MicroVM. It does not
grant the agent the root lifecycle environment, host control plane, another owner workspace,
arbitrary AWS APIs, raw integration secrets, or operations/resources denied by the other envelope
layers. The default child receives no AWS credential chain. Keep `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN`
false unless the entire execution role is intentionally model-visible.

Codex App Server is pinned to `approvalPolicy: "never"`; an unexpected approval-shaped protocol
request fails closed. The generic response route may supply ordinary requested data but cannot
widen authority. See [the capability envelope](capability-envelope.md) for the complete host and
agent contract.

## IAM separation

Do not collapse these roles:

1. **Lambda control/webhook roles** may validate secrets, store requests, update run state, and send SQS
   messages. They do not need model invocation or repository checkout access.
2. **Dispatcher role** reads run inputs and calls Lambda MicroVM launch/termination APIs. It is
   constrained by image and `iam:PassRole` conditions. `lambda:PassNetworkConnector` currently has
   no resource type or condition key, so that action alone requires `Resource: "*"`.
3. **MicroVM execution role** lets the trusted lifecycle server and runner read runtime run data and
   selected secrets, write artifacts/state, and optionally invoke the intended model. The current module
   scopes DynamoDB to the whole run table and S3 to `owners/*`, not one run; per-run credentials or a
   broker are a hardening item. The root lifecycle server performs mount/process setup and launches
   the trusted root runner. The runner starts Codex and Chromium as UID 10001 with sanitized
   environments; Codex should receive only a scoped Bedrock bearer key, and Chromium receives no AWS
   credential variables. Lambda's managed kernel exposes neither nftables nor the legacy
   `xt_owner` match, so startup loads and verifies a cgroup eBPF connect policy instead. It denies
   UID 10001 connections to guest-local TCP port 8080, allows the root-owned Lambda loopback proxy,
   and does not block unrelated external services on port 8080. External requests still require
   Lambda's port-scoped JWE proxy authorization. For conversational sharing,
   Codex can write only a versioned publication declaration containing retained relative paths. The
   trusted runner verifies owner scope, writes publication objects and grants, and returns the bearer
   URL through the encrypted result; the child receives neither S3 credentials nor CloudFront key
   material. For agent-callable integrations, the trusted runner reads only the selected account
   secret after broker authorization and passes it directly to the trusted adapter—not to Codex, its
   tool schema, its environment, or the browser helper.
4. **Notifier role** reads terminal artifacts and only the outbound secrets/APIs it serves. It does
   not run agents or clone repositories.

The control role has termination authority for cancellation but not launch or pass-role authority.
The dispatcher owns launch/pass permissions. Constrain the execution role and any future customer
connector according to the [MicroVM networking model](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).

Avoid `Resource: "*"` except where an AWS API genuinely cannot be resource-scoped, and pair it with
condition keys. In particular, constrain `iam:PassRole`, SSM parameter names, Lambda MicroVM images,
artifact prefixes, EventBridge buses, and secret ARNs. Keep the forced wildcard
`lambda:PassNetworkConnector` statement isolated and re-check AWS support as the service matures.

## Secret handling

- Store only ARNs and opaque route names in configuration; store values in Secrets Manager.
- Keep webhook verification, clone, model, and notification identities separate. Use the split
  GitHub/GitLab clone and notification ARN inputs; leave the deprecated combined-token compatibility
  inputs null so the agent worker never receives a provider-write credential.
- Prefer short-lived GitHub App/GitLab job or project tokens over static PATs.
- Never log raw webhook bodies, authorization headers, clone command environments, model credentials,
  Workflow URLs, or Slack tokens.
- The secret reader caches values in a warm Lambda/worker process for five minutes. Rotation is not
  instantaneous; allow both webhook secrets during a controlled migration only if the verifier is
  explicitly extended to support it.
- Treat a Teams Workflow URL as a credential even though it looks like a destination.
- Do not let general API callers choose arbitrary `credentialSecretArn` values. Validate against an
  owner/repository-to-secret allowlist or remove the field from a public projection.
- Keep `ALLOW_AGENT_AWS_CREDENTIAL_CHAIN=false` in deployed workers. `AGENT_PASSTHROUGH_ENV` is also a
  privileged policy surface; every added name must be reviewed as a secret/authority transfer.
- Keep the default `danger-full-access` policy only where a specific threat review accepts the outer
  task/VM, UID, IAM, filesystem, broker, and egress controls as the sandbox. Remove it from
  `ALLOWED_SANDBOX_MODES` when a deployment needs inner-sandbox enforcement as well.

For the preferred Codex path, trusted orchestration uses the MicroVM execution role to mint a
bounded short-term Bedrock token, places only that value in `AWS_BEARER_TOKEN_BEDROCK` for the agent
child, and deletes the parent environment value at cleanup. An explicitly configured
`BEDROCK_API_KEY_SECRET_ARN` is a compatibility path. Codex can alternatively use the AWS SDK
credential chain when explicitly enabled, but that expands agent authority and is a local/exception
escape hatch. The deployed mode uses `model_provider = "amazon-bedrock"`; see the official
[Codex on Amazon Bedrock setup](https://learn.chatgpt.com/codex/amazon-bedrock). The Bedrock identity
is separate from any OpenAI account, source owner, repository credential, and notification identity.

Trusted local runs may instead set `CODEX_AUTH_MODE=chatgpt`. The runner selects Codex's built-in
`openai` provider and reuses this device's cached `codex login` session; it withholds any stale
Bedrock bearer token. This policy is host configuration and is not accepted from a run request.
Do not copy `~/.codex/auth.json` into a MicroVM or secret-backed run: it contains reusable access and
refresh material that repository-controlled agent code could steal. OpenAI documents copied account
auth only as an advanced trusted-runner workflow and recommends API-key authentication for ordinary
automation.

The pinned Codex client sends `store: false` to the non-Azure Responses endpoint. Preserve and
re-audit that behavior on every Codex upgrade because the Bedrock Responses API otherwise stores
responses by default.

## Storage and retention

Run artifacts use S3-managed encryption (`AES256`); the immutable Thing definition bucket uses the
deployment data KMS key and bucket keys. Both store SHA-256 checksums and require TLS. If policy
changes either encryption mode, update bucket policy and writer behavior together and test every
writer.

DynamoDB TTL removes expired records asynchronously, not at an exact second. Configure an S3
lifecycle at least as strict as the run-retention policy and account for EventBridge/SQS DLQ replay
windows. Deleting the DynamoDB record before the artifact does not authorize the remaining object.
CloudWatch retention and notification-provider retention are separate.

Thing definitions intentionally have no run-artifact expiry because current and historical
revisions must remain executable/auditable. Archive does not delete a definition. Apply an explicit
reviewed product retention/deletion process before introducing automated definition expiry.

## Repository and process isolation

- Accept only allowlisted, credential-free HTTPS origins. Prefer immutable commit SHAs.
- The runner never interpolates a prompt, URL, ref, or path into a shell command. Preserve this
  argument-array invariant.
- The lifecycle server remains root only to mount S3 Files and control the worker process. Checkout,
  Codex, tools, and post-agent Git patch collection run as UID/GID 10001 with a small environment
  allowlist, so an untrusted `.git/config`, attributes file, filter, or textconv cannot regain root.
- Workspace paths are anchored beneath the configured root and deleted recursively only after that
  containment check.
- Do not mount the Docker socket, host paths, shared writable EFS, or a long-lived credential cache.
- Never reuse a workspace across owners or conversations. A conversation may reuse its own S3 Files
  workspace in a replacement VM only under the same fenced DynamoDB lease and hashed identity.
  Without S3 Files, expiry starts a clean VM and reconstructs context from the durable checkpoint.
- A `workspace-write` agent can change cloned content and those changes may be retained as a patch,
  but the runtime does not push commits. Do not add push credentials to the worker role.

## MicroVM-specific review

Lambda MicroVM images support lifecycle hooks and snapshots. At image build time, call the ready hook
only after generic initialization is complete; initialize run IDs, credentials, `/tmp`, and network
clients during the run hook. Validate the hook payload and keep it within the service's 4,096-byte
limit. A connector attached to a running VM is immutable.

Conversation continuation uses a short-lived MicroVM endpoint token scoped to port 8080. Keep token
minting and the HTTPS request inside trusted orchestration, serialize slices per conversation, and
never expose the endpoint/token to a webhook caller or agent process. Treat suspended memory and disk
as sensitive conversation state and rely on the configured expiry plus explicit teardown.

Use the AWS [image and lifecycle guidance](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
and [snapshot guidance](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html)
as release gates, not just implementation examples.

The AWSCC resource schema currently requires `additional_os_capabilities`, and the service currently
accepts only `ALL`. The trusted root lifecycle process uses those in-VM capabilities for S3 Files
mounting, process setup, and the cgroup eBPF control-plane guard; Codex and Chromium still drop to
UID/GID 10001. Re-evaluate that setting when the provider or service supports a narrower set, and
include it explicitly in the production threat review.

## Production security gates

Before calling this subsystem production-ready:

- complete an IAM and `iam:PassRole` review with deployed policy simulation;
- add WAF/API throttles, concurrency/budget ceilings, and webhook abuse controls;
- implement short-lived source-control credentials and prevent caller-selected secret access;
- prove the UID/environment credential boundary and keep the agent AWS-chain escape hatch disabled;
- enforce and test outbound network policy;
- add output redaction/mention controls and destination authorization;
- verify non-empty command triggers and the GitHub/GitLab result-marker/bot-author loop guards against
  real provider payloads, then add per-owner/thread cost limits;
- prove the state-stream failure-queue alarm and manual sequence-range/current-run replay procedure;
- keep the safe external Run projection regression-tested and add audit/rate limits around artifact-download authorization;
- scan and sign Lambda and MicroVM bundles/snapshots;
- run prompt-injection, SSRF/redirect, malicious-repository, cancellation, duplicate-delivery, and
  cross-owner isolation tests; and
- replace the Teams Workflow bridge with an authenticated Teams app gateway for primary-channel use.
