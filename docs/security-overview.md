# Security overview

Rat Things is an engineering preview for owner-operated deployments. In AWS, the
operator controls the account, identity configuration, infrastructure and data
retention. Its isolation controls do not make it production-ready for mutually
untrusted tenants. The [security and threat model](security.md) describes the
controls and remaining risks in detail.

Permissions are resolved before execution. The Agent receives only its admitted
tools, resource access and network policy. It works autonomously within those
limits; there are no mid-run human approvals. Missing permissions remain failures,
and an unexpected approval request fails closed. A prompt cannot grant additional
authority. See the [capability envelope](capability-envelope.md).

An AWS managed Session runs in a dedicated EC2 worker or Lambda MicroVM. Trusted
orchestration runs separately from agent commands, which use an unprivileged
identity. The outer VM is the primary execution boundary. Before managed setup
commands run, a startup check must verify that the inner sandbox permits workspace
writes and blocks writes outside it. A failed check prevents preparation from
continuing. A compromised worker kernel or privileged host remains a material risk.

Local inference and sign-in stay on the user's computer while managed commands run
inside an isolated Linux worker. The first supported container setup uses an Apple
silicon Mac with a VM-backed engine. Linux x86-64 also has an **explicit, unsigned
KVM development setup** built from source and selected through an asset directory.
It requires KVM and vsock support and has no signed desktop installation flow. Its
guest has no network interface. See [local workspaces](local-workspace.md) and the
[KVM setup](../testing/local-runtime/linux-kvm/README.md).

AWS integration secrets live in Secrets Manager. Service credentials remain in
trusted host processes. Vault placeholders allow the host to add authentication
headers only for approved HTTPS destinations without giving the guest the raw
secret. Plain environment values remain readable by sandbox code. The AWS ChatGPT
file bridge is an exception: code running under the agent's identity can read its
reusable login credentials. Use that bridge only for trusted workloads. See
[secret handling](security.md#secret-handling).

Agent command networking defaults to disabled. Enabling it grants only the admitted
policy; operators must also enforce appropriate deployment egress controls.
Model requests and trusted service integrations have separate network paths.
Transport encryption alone does not make a self-hosted executor safe.

On AWS, prompts, journals and artifacts use encrypted S3 storage; DynamoDB holds
resource state, references and bounded summaries. Local SQLite resource payloads
are encrypted, but their key is accessible to the same OS user. Rat Things does
not encrypt local workspace files or Codex's private login/history directory;
use device encryption. Logs, provider copies and stored objects have separate
retention lifetimes. See [storage and retention](security.md#storage-and-retention).

Operators remain responsible for IAM scope, identity mapping, budgets, backups,
secret rotation and incident response. Local Vaults, MCP and provider webhooks are
currently unavailable. Review the [current limitations](status-and-roadmap.md#known-gaps)
before choosing a deployment.
Support coverage and update responsibilities are [agreed during the paid assessment](support.md).
