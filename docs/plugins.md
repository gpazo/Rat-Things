# Integrations, accounts, and permissions

Rat Things exposes trusted external APIs to Codex as dynamically registered App Server tools. The
model is intentionally account-oriented: one owner can connect any number of accounts for the same
service, select one or more accounts for a run, and narrow each account independently.

This is the first useful slice of a Zapier-like integration platform, not a claim of complete Zapier
parity. Zapier's current platform documentation describes the same core building blocks: an
authentication creates a connection, integrations define typed triggers/searches/creates, and each
operation declares its input fields. See Zapier's
[CLI platform overview](https://docs.zapier.com/integrations/build-cli/overview),
[authentication overview](https://docs.zapier.com/integrations/build/auth), and
[OAuth v2 flow](https://docs.zapier.com/integrations/build/oauth), plus Zapier's
[recommended trigger/action model](https://docs.zapier.com/integrations/quickstart/recommended-triggers-and-actions).
Rat Things combines those
connection and operation concepts with agent-visible tools and a host-side permission broker.

## Concepts

| Object | Purpose | Contains secrets? |
| --- | --- | --- |
| Integration plugin | Trusted manifest and implementation for one external API | No |
| Connection | One owner-scoped account or tenant for a plugin | No; only auth/scope metadata |
| Credential binding | Host-only pointer from a connection to Secrets Manager | ARN only |
| Grant | Persistent Rat-side permission ceiling for one connection | No |
| Connection set | Reusable group of connections, including multiple accounts of one plugin | No |
| Source binding | Assigns a profile and/or connection set to a verified webhook source | No |
| Run selection | Selects accounts and optionally narrows their grants for one run | No |

A Slack consultancy, for example, can create `slack-agency`, `slack-client-a`, and
`slack-client-b`. A tool call must choose the exact account alias. Sharing a plugin ID never implies
sharing credentials or authority between those connections.

## Permission intersection

An operation is available only when every applicable layer permits it:

1. The provider authorization recorded for the connection must include the operation's access
   level. When the provider exposes granular scopes, all declared required scopes must also be
   present.
2. The persistent connection grant must permit the operation.
3. The selected capability profile cannot be exceeded.
4. A run-level connection selection can narrow the persistent grant again.
5. `denyOperations`, expiration, resource constraints, and required approvals are then enforced.

The effective permission is therefore the intersection, never the union. A full-access API key can
be exposed to a run as read-only, but a read-only provider token cannot be widened by a Rat grant.

The presets are:

| Preset | Operations made eligible |
| --- | --- |
| `read-only` | `read` |
| `read-write` | `read` and `write` |
| `full` | `read`, `write`, and `full` |
| `custom` | Only IDs in `allowOperations` |

Provider permissions and Rat permissions remain separate on purpose. For OAuth tokens with granular
scopes, both provider and broker enforce the limit. For a coarse or unknown provider authorization,
Rat can still enforce its grant, but the upstream system may see a broadly privileged credential.
Use `authorization.scopeModel: "coarse"` or `"unknown"` honestly rather than inventing scopes the
provider does not enforce.

`resourceConstraints` restrict operation input fields to explicit string values. A grant such as
`{"channel":["C01234567"]}` prevents every operation using that grant from selecting another
`channel`. Constraints are checked before approval and before the credential is read.

Each operation also declares `never`, `on-request`, or `always` approval behavior. A trusted owner
can replace that default in the persistent grant. Browser clicks, typing, key presses, and selections
use the run's live approval policy as a separate control. `accept-for-session` is cached only for the
active agent session and the exact on-request operation/account or browser tool; an `always`
integration operation asks again on every call.

## Connect multiple accounts

Connection creation accepts credential material only on the authenticated management route. The
credential is written to a dedicated Secrets Manager secret; the response, DynamoDB item, run
request, MicroVM launch payload, App Server schema, and model-visible environment contain no value.

```bash
rat-things plugins
rat-things connect --file examples/integration-connection-slack.json
rat-things connect --file /secure/config/slack-second-account.json
rat-things connections
```

The versioned request shape is:

```json
{
  "version": "1",
  "pluginId": "slack",
  "alias": "slack-shop",
  "externalTenantId": "T01234567",
  "externalSubjectId": "U01234567",
  "authorization": {
    "scheme": "oauth2",
    "access": "write",
    "scopeModel": "granular",
    "scopes": ["search:read", "chat:write"]
  },
  "credential": {
    "access_token": "supplied-only-to-this-management-call"
  },
  "grant": {
    "version": "1",
    "preset": "read-only"
  }
}
```

Aliases are unique per owner, not globally. Repeat this call with a different alias to connect a
second account for the same plugin. Rotate or revoke an account independently:

```bash
rat-things rotate slack-shop --file /secure/config/slack-rotated-credential.json
rat-things revoke slack-old-client
```

Credential rotation accepts `{"version":"1","credential":{...}}`. Revocation marks the
connection revoked and asks Secrets Manager to delete its credential; existing run requests still
cannot use it because status is rechecked at tool-session creation.

OAuth authorization-code initiation, redirect handling, token refresh, and provider-side account
verification are not implemented yet. The current route registers an already-issued credential and
accurately records its provider authorization. That is suitable for self-hosted operators and API
keys, but it is not yet the seamless end-user OAuth experience described in Zapier's OAuth docs.

## Grants and account sets

Replace a persistent account grant with:

```bash
rat-things grant slack-shop --file /secure/config/slack-shop-grant.json
```

```json
{
  "version": "1",
  "preset": "custom",
  "allowOperations": ["slack.messages.search", "slack.messages.post"],
  "denyOperations": [],
  "approvalOverrides": [
    { "operationId": "slack.messages.post", "approval": "always" }
  ],
  "resourceConstraints": {
    "channel": ["C01234567"]
  },
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

Connection sets make a multi-account selection reusable:

```bash
rat-things connection-set --file /secure/config/customer-ops-set.json
rat-things connection-sets
```

```json
{
  "version": "1",
  "name": "customer-ops",
  "connections": ["slack-shop", "stripe-shop", "slack-agency"],
  "defaults": {
    "support": "slack-shop",
    "billing": "stripe-shop"
  }
}
```

When exactly one eligible account is configured as the default for a plugin, operation, or
capability label, the tool schema makes `account` optional and the broker resolves that connection.
An explicit account always wins; ambiguous multi-account tools still require an exact alias. A run
can select the whole set, individual accounts, or both:

```bash
rat-things --thread shop-ops \
  --profile small-business \
  --connection-set customer-ops \
  --connection slack-agency=read-only \
  --deny-operation slack-agency=slack.messages.post \
  "Review support and billing exceptions"
```

The equivalent run fragment is:

```json
{
  "integrations": {
    "connectionSet": "customer-ops",
    "connections": [
      {
        "connection": "slack-agency",
        "preset": "read-only",
        "denyOperations": ["slack.messages.post"]
      }
    ]
  }
}
```

Run-level policy cannot change credentials, provider scopes, persistent approval overrides, resource
constraints, or expiration. It can only select and narrow accounts.

## Source-bound permissions

Verified webhook sources can receive a preconfigured capability profile and connection set without
placing policy IDs in an untrusted provider payload. The ingress service finds an owner-scoped source
binding only after signature verification and carries its owner as the separate capability owner.

```bash
rat-things bind-source --file /secure/config/client-channel-binding.json
rat-things source-bindings
```

```json
{
  "version": "1",
  "sourceKind": "slack",
  "selector": {
    "teamId": "T01234567",
    "channelId": "C01234567"
  },
  "capabilityProfile": "small-business",
  "connectionSetId": "customer-ops"
}
```

Selectors are exact matches against trusted normalized source fields. A binding does not alter run
ownership and does not embed a grant or credential. Provider normalizers retain their read-only
fallback when no binding matches. When a trusted binding selects a profile, that profile supplies
the effective sandbox and capability defaults; this is how an operator deliberately enables the
MicroVM-oriented browser/network surface for one verified webhook source without trusting policy
fields from the webhook payload.

The current IAM management route treats its caller as an operator; it does not perform a provider
OAuth/install handshake proving that caller owns the selected team, channel, or repository. The
table prevents two operators from claiming the exact same selector, but self-hosted deployments must
restrict this route to their trusted administrator until provider-authorized onboarding exists.
API-source bindings are the exception: they are owner-scoped because an API source has no external
installation identity and therefore cannot delegate policy across principals.

## Built-in integration tools

Two reference integrations are registered:

| Plugin | Operations |
| --- | --- |
| Slack | Search messages, post a message, add a reaction |
| Stripe | Search customers, list invoices, create a refund |

Their HTTPS origins are fixed in trusted code, redirects are rejected, request/response bodies are
bounded, and credentials are added only to authorization headers. Slack's HTTP-200 error envelope is
also checked. These adapters demonstrate the contract; they are not a broad app catalog.

At turn start Rat Things registers only authorized operations as App Server dynamic tools. Each tool
schema includes an `account` enum containing eligible aliases and a nested typed `input` object. The
reserved App Server namespaces are rejected at plugin registration; the browser helper uses
`rat_browser` for the same reason.

## Add an integration plugin

Integration plugins are trusted TypeScript adapters compiled into the MicroVM image. To add one:

1. Define an `IntegrationPluginManifest` with a lowercase ID, supported authentication schemes, and
   namespaced operation IDs under `src/plugins/integrations`.
2. Give every operation an access level, risk, approval default, optional provider scopes, and JSON
   input schema.
3. Prefer `TrustedHttpIntegrationPlugin`: pin a credential-free HTTPS base URL and build relative
   paths from validated inputs. Never accept an arbitrary URL from the model.
4. Register the adapter in `src/plugins/integrations/builtins.ts`.
5. Add tests for auth placement, fixed-origin behavior, provider error envelopes, permission
   intersection, resource constraints, approvals, and response bounds.
6. Rebuild and redeploy the trusted MicroVM image.

This is intentionally not arbitrary npm-package loading. A public plugin SDK, signed package
distribution, migrations, OAuth lifecycle, polling/webhook trigger orchestration, visual field
mapping, and a community catalog are deferred until the trusted core works well. Enterprise-only
governance and a separate always-on Node execution tier are also deferred.

The provider ingress/delivery plugin contract remains separate. Webhook signature parsing belongs in
`src/ingress`/`src/channels`, result notification belongs in `src/delivery`, and agent-callable API
operations belong here. `npm run architecture:check` enforces those dependency boundaries.
