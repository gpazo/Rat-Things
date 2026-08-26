# The capability envelope

Rat Things does not pause a running agent for human approval. A host admits a fixed capability
envelope before the MicroVM starts; the agent then operates autonomously inside that envelope. To
reduce authority, change the envelope for a future Run instead of adding a mid-Run prompt.

This is a product and security contract, not only a user-interface choice. Discovery reports
`approvals: false`, the public API has no approval route, the CLI has no approval command, and the
runner pins Codex App Server's approval policy to `never`.

## The rule

```text
authenticated owner and source
        ∩ deployment capability profile
        ∩ Run or Thing narrowing
        ∩ execution-role IAM
        ∩ network and VPC policy
        ∩ provider authorization and scopes
        ∩ Rat connection grant and resource constraints
        ∩ installed tools, skills, apps, and MCP servers
        = the authority available for this Run
```

Every layer can narrow authority. No layer can widen another one, and a prompt cannot grant a
capability. The intersection is resolved before an operation is exposed or its credential is read.

Inside the resulting envelope, the agent may use admitted shell, Git, filesystem, browser, network,
and integration operations without asking a person again. Outside it, the capability is absent or
the trusted broker rejects it. The agent cannot obtain authority by asking for approval.

## What “outside the envelope” means

“Unavailable” is an enforcement outcome, not a waiting state. Depending on the surface, the agent
will see one of these results:

- an uninstalled or unrequested tool is not present in the tool inventory;
- a denied integration operation is not exposed, or its broker rejects the call before reading a
  credential;
- a filesystem path outside the Run workspace is absent or rejected by the guest operating system;
- an AWS request has no agent credential chain by default, or AWS returns `AccessDenied` for an
  action or resource excluded by the execution role;
- a browser URL is rejected by URL policy, or a network destination is blocked by VPC/egress
  policy; and
- another owner's connection, artifact, conversation, Run, or control-plane route fails the
  owner/identity check and is never substituted with a broader identity.

These surfaces do not all share one transport-level error code. They do share one semantic rule:
denial never creates a pending approval that can widen the current Run. The agent should report the
specific missing capability. The host may submit a new Run or publish a new Thing revision with a
different reviewed envelope; it cannot authorize the denied operation by responding to the active
Run.

## What `danger-full-access` means

`danger-full-access` means broad command and filesystem access **inside one isolated MicroVM**. It
does not mean access to the AWS account, host control plane, other tenants, arbitrary integration
credentials, or every network destination.

| Surface | How authority is admitted | What remains unavailable unless separately granted |
| --- | --- | --- |
| Guest shell and filesystem | Sandbox profile plus the per-Run workspace | Host filesystem, another owner workspace, root lifecycle process |
| AWS APIs | MicroVM execution-role IAM and whether an agent credential chain is deliberately exposed | All actions and resources denied by IAM; the default agent child receives no AWS credential chain |
| Connected accounts | Provider scopes, persistent Rat grant, profile ceiling, Run/Thing narrowing, operation allow/deny lists, resource constraints | Other connections, denied operations, disallowed resource values, raw secret values |
| Browser and network | Profile, `networkAccess`, computer-use setting, connector/VPC/egress rules, browser URL checks | Loopback, link-local, metadata, private targets, and anything denied by egress policy |
| Skills, apps, MCP, and dynamic tools | Installed inventory, profile allowlists, and the Run/Thing request | Uninstalled, unrequested, or profile-denied capabilities |
| Control plane | Owner-authenticated host APIs and AWS-issued MicroVM proxy token | The agent UID cannot call the guest-local lifecycle/control listener or alter its own envelope |

The outer MicroVM is the isolation boundary. UID separation, a sanitized child environment, the
guest-local control-port policy, the credential broker, and browser URL controls are additional
defenses inside that boundary.

## Why there is no approval button

A mid-Run approval would be a second authorization system with its own identity, liveness, replay,
expiry, and race semantics. Rat Things instead expects the host to decide authority at admission:

- use `read-only`, `workspace-write`, or remove `danger-full-access` from the deployment allowlist;
- choose a narrower capability profile;
- disable network, browser use, search, an app, a skill, or an MCP server;
- narrow the MicroVM execution role and network connector;
- connect a provider credential with smaller upstream scopes;
- set a connection grant to `read-only`, add an operation allowlist or deny list, or constrain input
  resources; and
- omit an account or tool entirely.

If the intended task cannot safely run autonomously with that static authority, do not launch it.
Split it into a read-only preparation Run and a separately submitted execution Run with a reviewed,
narrower input and explicit capability envelope. That second submission is a new authorization
decision, not approval of a suspended tool call.

## Instructions for agents

An agent using Rat Things must follow these rules:

1. Discover the installed profiles, integration manifests, and OpenAPI before submitting work.
2. Select the narrowest envelope that can complete the task. A request can narrow a profile but
   cannot widen it.
3. Never wait for, invent, or call an approval route. Rat Things has none.
4. Treat `not found`, `forbidden`, `AccessDenied`, missing-tool, blocked-URL, and network-policy
   failures as capability-boundary outcomes when they correspond to the resolved envelope. Report
   the exact missing capability; do not wait for an approval prompt.
5. Ask the operator to change a future Run or Thing revision when the task genuinely needs that
   capability. Do not search for another owner, account, credential, path, or network route.
6. Treat a generic pending input request as data needed to continue, not as permission to widen
   authority.
7. After interruption or replacement, do not automatically repeat a consequential external tool
   call whose outcome is unknown. Inspect durable evidence or provider state and require a new,
   explicit instruction when necessary.

The Codex protocol still contains approval-shaped methods for other hosts. Rat Things starts turns
with `approvalPolicy: "never"`. If Codex nevertheless emits a command or file approval request, the
runner rejects it with `interactive approvals are disabled; capabilities must be admitted before
MicroVM launch`. That is a configuration/protocol failure, not a request a user can accept.

## Instructions for hosts and operators

Before launching a Run or publishing a Thing revision, review the envelope as authorization:

1. Confirm the authenticated owner and trusted source binding.
2. Inspect the resolved capability profile and sandbox.
3. Confirm network, browser, search, skills, apps, and MCP selections.
4. Inspect every selected connection's provider scopes, Rat grant, operation set, expiry, and
   resource constraints.
5. Review execution-role IAM and egress policy for authority that is not represented as a dynamic
   integration tool.
6. Run the Thing explanation and repair every error diagnostic.
7. Test the exact immutable draft, then publish only the tested revision and hash.

Changing IAM, a grant, provider scopes, or a profile affects future capability resolution. Do not
assume it safely revokes an external side effect that is already in progress. Interrupt or cancel
the active Run when immediate containment is required, then reconcile provider state.

## Generic input is different

The active-Run response route remains for ordinary App Server requests that need JSON data to
continue, such as structured user input. It does not authorize a command, file change, browser
action, integration operation, or broader account access. Responses cannot change the capability
envelope.

Live pending requests are ephemeral with the active MicroVM. Durable conversations, Run state,
S3-backed inputs/results, files, and terminal event artifacts remain the authoritative record.

## Security consequence

This model deliberately trades interactive human intervention for a smaller and auditable
authorization surface. Its safety depends on the envelope being correct. Production deployments
must keep IAM least-privileged, provider credentials scoped, egress constrained, grants explicit,
and built-in adapters reviewed. Assume the model will fully exercise every admitted capability.

Continue with [security](security.md), [integrations and grants](plugins.md), [agent
instructions](agents.md), and [architecture](architecture.md) for implementation details.
