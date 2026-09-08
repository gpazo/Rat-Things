# The capability envelope

Rat Things does not pause a running agent for human approval. A host admits a fixed capability
envelope before the MicroVM starts; the agent then operates autonomously inside that envelope. To
reduce authority, change the envelope for a future Run instead of adding a mid-Run prompt.

Discovery reports `approvals: false`; the API and CLI have no approval operation.

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

## What “outside the envelope” means

A capability is absent or its enforcing layer rejects it. Missing tools, broker rejections,
`AccessDenied`, owner-check failures, and blocked URLs have different error codes, but none creates
a pending approval. Report the missing capability without seeking another identity, credential,
path, or network route. A host must submit a new Run or publish a new Thing revision to admit
additional authority.

The runner starts Codex turns with `approvalPolicy: "never"`. If Codex nevertheless emits a command
or file approval request, the runner rejects it with `interactive approvals are disabled;
capabilities must be admitted before MicroVM launch`. Treat this as a configuration or protocol
failure.

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

## Instructions for agents

1. Discover the installed profiles, integration manifests, and OpenAPI before submitting work.
2. Select the narrowest envelope that can complete the task; see
   [integration grants](plugins.md#5-understand-effective-permission) for account restrictions.
3. Treat a generic pending input request as data needed to continue. It cannot widen authority.
4. After interruption or replacement, do not automatically repeat a consequential external tool
   call whose outcome is unknown. Inspect durable evidence or provider state and require a new,
   explicit instruction when necessary.

## Instructions for hosts and operators

Before launch, assume the agent will fully exercise every admitted capability:

1. Confirm the authenticated owner, trusted source binding, profile, sandbox, and selected tools.
   Disable unnecessary network, browser, search, skills, apps, and MCP access.
2. Inspect every selected connection's provider scopes, Rat grant, operation set, expiry, and
   resource constraints.
3. Review execution-role IAM and egress policy for authority that is not represented as a dynamic
   integration tool.
4. For a [Thing](things.md), repair all explanation errors, test the exact immutable draft, and
   publish only the tested revision and hash.

If a task requires a human decision before a consequential action, split it into a read-only
preparation Run and a separately submitted execution Run with reviewed input and a narrow envelope.

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

Continue with [security](security.md), [integrations and grants](plugins.md), [agent
instructions](agents.md), and [architecture](architecture.md) for implementation details.
