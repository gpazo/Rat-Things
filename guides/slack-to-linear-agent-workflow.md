# How to turn a Slack request into a Linear issue with an AI agent

A safe Slack-to-Linear agent should verify the Slack event, preserve the source thread, search for
the approved decision, check Linear for existing work, attempt one bounded issue creation only when
needed, and return the Linear link to the same conversation. Slack read access and Linear write
access should use separate verified accounts and independently bounded grants.

> **Short answer:** use separate search and create tools, constrain creation to the approved team,
> and treat “search first, create once” as an acceptance criterion—not as an invariant enforced by
> the current allowlist. Enforce ordering and at-most-once creation in trusted host code when the
> workflow cannot tolerate duplicates.

## Define the outcome before choosing tools

The useful outcome is not “connect Slack and Linear.” It is a traceable handoff:

1. A person identifies a decision or request in Slack.
2. The agent finds the exact source messages and their links.
3. The agent searches Linear for matching work.
4. If no match exists, it creates one issue with the source context.
5. The agent records what it did and returns the Linear identifier and URL.
6. A follow-up remains attached to the conversation that started the work.

This sequence reduces duplicate issues and preserves provenance. It also yields a bounded tool
ledger that can be compared with the final provider state.

## Keep ingress, execution, and delivery separate

When Slack starts the workflow, verify the signing secret and timestamp before parsing the request
or enqueueing work. Slack's official request-signing procedure uses the raw request body,
`X-Slack-Signature`, and timestamp freshness to authenticate the sender. Derive the owner and source
binding from that verified event; do not accept either identity from prompt text.

Execution then receives only the connected accounts and operations admitted for that source.
Terminal delivery is a third stage with its own credential and idempotency fence. This separation
prevents a Slack payload shape, model process, or result formatter from becoming the authorization
system for every stage.

Rat Things maps a verified Slack thread to one durable conversation. Every accepted request has one
Run receipt in the control plane, and the eventual answer returns to the source thread through
trusted delivery. Review the current [Slack experience and boundaries](../docs/slack.md).

## Connect Slack and Linear

Use deployment-owned OAuth applications or host-supplied credentials to connect:

- a Slack account authorized to search the installing user's visible messages; and
- a Linear application authorized for the intended workspace.

Rat Things verifies each provider identity before storing its credential in Secrets Manager.
Reconnection must resolve to the same provider tenant and subject, so an expired token cannot be
silently replaced with another workspace while keeping the same alias and consumers.

The model sees stable aliases such as `slack-work`, `linear-read`, and `linear-create`, their
operation schemas, and bounded identity metadata. It never receives a raw token.

## Give the handoff only the operations it needs

Use one Slack read alias, one Linear read alias, and a create-only Linear alias. The two Linear
Connections represent the same approved workspace with different grants. Before running the
handoff, save the following as `linear-create-grant.json`, replace the example UUID with the
approved team ID, and apply it to `linear-create`.

```json
{
  "version": "1",
  "preset": "custom",
  "allowOperations": ["linear.issues.create"],
  "denyOperations": [],
  "resourceConstraints": {
    "teamId": ["8ea80d74-4e1e-4d00-b3ae-271b2f7a8d28"]
  }
}
```

```bash
npm run rat-things -- grant linear-create --file linear-create-grant.json
```

After the grant is installed, run the workflow:

```bash
npm run rat-things -- chat --thread renewal-handoff \
  --connection slack-work=read-only \
  --allow-operation slack-work=slack.messages.search \
  --connection linear-read=read-only \
  --allow-operation linear-read=linear.teams.list,linear.issues.search \
  --connection linear-create=read-write \
  --allow-operation linear-create=linear.issues.create \
  "Find the approved renewal decision in Slack. Check Linear for an existing matching issue. \
  If none exists, create one in the customer-ops team with the open security items and Slack \
  permalink in its description. Return the Linear identifier and URL."
```

Do not put `linear.teams.list` or `linear.comments.create` under that grant: neither operation has a
`teamId` input, so the broker would reject it. The read alias does not need write authority, and the
create alias cannot update or comment on existing work.

Notice what is missing: `linear.issues.update`. If a matching issue already exists, this Run can
report it but cannot modify it. Add update authority only to a workflow whose approved outcome
requires changing existing work.

These controls enforce account, operation, and create-team boundaries. They do **not** force the
model to search before creating, and they do not limit how many times it can invoke the create tool.
Rat Things' current Linear OAuth manifest also requests broad `read,write`; the operation grants
narrow agent behavior inside that broader provider credential rather than replacing it with
Linear's documented granular scopes.

## Make duplication an explicit failure case

Search is not a perfect uniqueness constraint. Two concurrent Runs can both observe no match and
create separate issues unless the provider or workflow supplies an idempotency boundary.

For low-volume human handoffs, serialize work by source thread, ask for the search immediately
before creation, and verify the ledger afterward. That reduces risk but is still prompt/tool
coordination, not a hard uniqueness boundary.

For higher-volume automation, add a trusted composite operation that accepts the source permalink
and approved team, performs the Linear search, acquires a host-side claim keyed to the source, and
creates only for the claim winner. Rat Things does not currently ship that composite. Until it
does, a deterministic external reference and reconciliation job can make duplicates discoverable,
but cannot promise at-most-once provider writes. Always retain the Slack permalink in the issue.

The conversation input itself should have an idempotency key when a client may retry submission.
That prevents duplicate Runs for the same semantic request; it does not automatically make an
external provider write exactly once.

## Verify the effect, not the prose

A successful agent answer is not proof that Linear changed correctly. Inspect:

- the durable tool-call ledger and settled outcomes;
- the account alias used for each operation;
- the number and order of searches and writes;
- the returned Linear identifier and URL; and
- a provider read-back of the issue.

The acceptance target for the example is one Slack search, team discovery when necessary, one
Linear search before any write, and zero or one issue creation. The available-operation policy does
not guarantee that order or count, so fail the acceptance test if the ledger differs. If the write
response is ambiguous, inspect Linear before repeating it.

## Current boundaries

This is a workflow you configure from the installed tools, not a built-in transaction across
Slack and Linear. Grants restrict operations but do not enforce their order or call count. Search
before creating and inspect the returned issue ID, while accounting for concurrent Runs that can
still create duplicates. Linear writes use the app actor. Native Linear mentions and Agent Session
ingress are not implemented; Slack search depends on a legacy provider endpoint.

## Production checklist

Before enabling the workflow broadly:

1. Verify Slack signatures before accepting work.
2. Bind the source workspace and channel to a trusted owner policy.
3. Use separate verified Slack and Linear Connections.
4. Limit Slack to search, use a separate Linear read alias, and constrain a create-only alias to the approved team.
5. Add a duplicate-issue strategy appropriate to the workflow volume.
6. Retain the source permalink, Run receipt, and tool ledger.
7. Reconcile unknown write outcomes instead of replaying them blindly.
8. Add rate limits, budgets, egress controls, and failure-queue alarms.

Follow [the Linear setup guide](../docs/linear.md) to install the OAuth application, verify the
Connection, run the bounded demo, and inspect the current limitations.

## Sources

- [Slack request-signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack `search.messages` scope, arguments, and legacy status](https://docs.slack.dev/reference/methods/search.messages/)
- [Slack Real-time Search API migration guidance](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- [Linear OAuth scopes and app actors](https://linear.app/developers/oauth-2-0-authentication)
- [Linear GraphQL authentication and error handling](https://linear.app/developers/graphql)
- [Rat Things Slack implementation boundaries](../docs/slack.md)
- [Rat Things Linear integration](../docs/linear.md)
