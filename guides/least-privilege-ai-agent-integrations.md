# How to give an AI agent limited access to Slack and Linear

Do not give an AI agent a provider token and ask it to behave. Keep credentials in a trusted host,
expose reviewed operations as typed tools, and calculate effective access as the intersection of
provider scopes, a persistent account grant, the selected workflow, operation and resource rules,
IAM, and network policy. The model should receive aliases and schemas—not raw tokens.

> **Short answer:** least privilege for an agent is enforced by the capabilities it can actually
> exercise, not by a sentence in its prompt.

## Separate identity from authority

An integration workflow involves several identities that are easy to collapse accidentally:

- the authenticated Rat Things owner;
- the human or service that initiated the request;
- the Slack workspace or Linear organization;
- the provider subject represented by the credential;
- the app or bot actor that performs a write; and
- the destination that will receive the result.

Keep those fields distinct. A caller should not be able to submit another owner's identifier, swap
the credential subject, or redirect output merely by changing prompt text.

Rat Things verifies a Connection with its provider before persistence, derives stable provider
identity, and scopes the Connection to the authenticated owner. OAuth and grant management remain
host control-plane operations and are never exposed to the running agent.

## Build permission as an intersection

Rat Things resolves effective authority before the MicroVM launches:

```text
authenticated owner and source
        ∩ deployment profile
        ∩ provider authorization and scopes
        ∩ persistent account grant
        ∩ Thing or Run selection
        ∩ operation and resource constraints
        ∩ IAM and network policy
        = authority available to the agent
```

Every layer can narrow access; no layer can widen another. A provider token with write scope does
not force a Run to receive write tools. Conversely, a `read-write` Run cannot manufacture a write
operation that the provider scope, persistent grant, or deployment profile denies.

Use [the capability envelope](../docs/capability-envelope.md) for the complete security contract and
[integrations, accounts, and permissions](../docs/plugins.md) for the Connection lifecycle.

## Prefer typed operations over arbitrary provider requests

A safe tool adapter fixes the provider origin, HTTP method or GraphQL document, request schema,
response projection, timeouts, and size limits. The model supplies only the bounded input fields
needed for one operation.

The built-in Linear adapter, for example, exposes named operations such as
`linear.issues.search`, `linear.issues.get`, `linear.issues.create`, and
`linear.comments.create`. It sends reviewed GraphQL documents only to Linear's API; the model
cannot provide an arbitrary GraphQL query, choose another origin, request OAuth scopes, or retrieve
the token.

Slack similarly separates delegated message search from bot-authored posting and reactions because
those actions may use independently authorized token families. Rat Things currently implements
`slack.messages.search` with Slack's user-token [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/)
method and its `search:read` scope. Slack now labels that endpoint legacy and recommends its
Real-time Search API, so this adapter has a disclosed provider-dependency and migration risk.

Linear documents narrower `issues:create` and `comments:create` OAuth scopes alongside its broader
`write` scope. The current Rat Things Linear OAuth manifest still requests `read,write`, and its
write operations require the broad `write` scope. The operation allowlist narrows what the agent
can call, but it does not make that provider credential narrowly scoped. Migrating the adapter to
Linear's granular scopes remains separate product work.

## Start with a read-only Run

Select one exact account alias and the minimum operation list:

```bash
npm run rat-things -- chat \
  --thread renewal-research \
  --connection slack-work=read-only \
  --allow-operation slack-work=slack.messages.search \
  "Find the approved renewal decision and return links to the source messages. Do not post."
```

The prompt states the user's intent, but the account preset and allowlist enforce it. If the agent
tries to post, the operation is absent or rejected before the credential is read.

Use a separate Run when a later action genuinely needs write authority:

```bash
npm run rat-things -- chat \
  --thread renewal-tracking \
  --connection linear-work=read-write \
  --allow-operation linear-work=linear.teams.list,linear.issues.search,linear.issues.create \
  "Search for an existing renewal issue. If none exists, create one in the approved team."
```

For finer control, make the resource boundary part of a persistent grant whose every admitted
operation contains the constrained field. For example, a separate `slack-customer-post` Connection
can permit posting only to one provider channel ID:

```json
{
  "version": "1",
  "preset": "custom",
  "allowOperations": ["slack.messages.post"],
  "denyOperations": [],
  "resourceConstraints": {
    "channel": ["C01234567"]
  }
}
```

```bash
npm run rat-things -- grant slack-customer-post --file slack-customer-post-grant.json
```

Resource constraints are evaluated for every admitted operation. A grant that combines
`slack.messages.search` with a `channel` constraint is invalid because the search tool accepts only
`query`; the broker rejects the call before credential access. Use separate aliases for differently
shaped operations, or omit a constraint that the complete operation set cannot satisfy. Do not
allow a model to choose from every connected account when the workflow already knows the intended
workspace.

## Keep credentials out of agent-visible state

Provider tokens should never appear in a prompt, Thing definition, Run request, DynamoDB item, tool
argument, result body, repository URL, or Terraform state. Rat Things stores each credential in a
per-Connection Secrets Manager secret. A trusted broker resolves the account alias and checks every
authority layer before it reads that secret and calls the reviewed adapter.

The model can see bounded identity, health, scope, and operation metadata. It cannot test a
credential, reconnect OAuth, rotate a token, rename an account, or change its persistent grant.
Those are authenticated host operations that affect only future capability resolution.

## Treat “no approval prompt” as a design constraint

Rat Things has no mid-Run human approval layer. Inside the fixed envelope, every exposed action is
autonomous. Outside it, the tool is missing or the enforcing layer denies the operation. The denial
never becomes a pending request that can widen the active Run.

This means the pre-launch envelope must be safe even if the model fully exercises it. If a task
cannot satisfy that rule, split it into a read-only preparation Run and a separately submitted,
narrowly authorized execution Run after human review.

## Audit effects independently of the final answer

Do not infer provider activity from agent prose. Retain a durable tool-call ledger containing the
account alias, operation, bounded input and output metadata, timing, and settled outcome. For writes,
confirm provider state when practical.

AWS similarly recommends granting only the IAM actions and resources required by the workload and
restricting access to individual Secrets Manager secrets. Those controls protect the trusted
broker boundary; they do not replace provider scopes or Rat Things operation rules.

## Current boundaries

Slack search uses the provider's legacy `search.messages` method, and Linear OAuth requests broad
`read,write` scopes. Rat grants and per-Run operation lists narrow those provider credentials.
Public egress is broad by default; output DLP and tenant budgets remain incomplete. Built-in
adapters are trusted code. See the [security threat matrix](../docs/security.md#threats-and-controls)
before connecting sensitive accounts.

## A least-privilege checklist

Before enabling an integration, verify:

1. The provider identity was verified and is bound to the authenticated owner.
2. Provider scopes are no broader than the integration requires.
3. The persistent account grant narrows those scopes further when possible.
4. The workflow selects an exact account alias and operation allowlist.
5. Every resource constraint names an input field present on every operation admitted by that grant.
6. The agent receives no credential value or arbitrary provider-request primitive.
7. The durable ledger and provider state can establish what happened.
8. IAM, network egress, rate limits, and cost limits match the same risk decision.

## Sources

- [Slack `search.messages` scope, arguments, and legacy status](https://docs.slack.dev/reference/methods/search.messages/)
- [Slack Real-time Search API migration guidance](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- [Linear OAuth scopes and PKCE](https://linear.app/developers/oauth-2-0-authentication)
- [Linear GraphQL authentication and error handling](https://linear.app/developers/graphql)
- [AWS IAM least-privilege guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html)
- [AWS Secrets Manager security best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html)
