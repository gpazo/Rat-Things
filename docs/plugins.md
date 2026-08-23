# Integrations, accounts, and permissions

Rat Things turns trusted external APIs into agent-visible tools. One deployment can serve one
person, a team, or an embedded product; every connection remains scoped to the authenticated owner.
An owner can connect several accounts for the same service and grant each account different access.
This is the account-connection step in the [Rat Things operating model](operating-model.md).

> Once this narrow journey is delightful and stable, expand it.

The narrow journey is:

```text
discover integration -> supply credential -> verify provider account -> choose Rat access
                     -> select account for a Thing/run -> approve consequential writes
```

This is the useful core of a Zapier-like integration system, not a claim of Zapier parity. Zapier's
current platform also separates authentication/connections from typed triggers, searches, and
actions. Its official references are the
[CLI platform overview](https://docs.zapier.com/integrations/build-cli/overview),
[authentication overview](https://docs.zapier.com/integrations/build/auth),
[OAuth v2 flow](https://docs.zapier.com/integrations/build/oauth), and
[recommended triggers and actions](https://docs.zapier.com/integrations/quickstart/recommended-triggers-and-actions).
Rat Things applies that model to a headless, self-hosted agent backend with explicit permissions.

## The Integration Contract v1

| Object | Purpose | Secret material? |
| --- | --- | --- |
| Integration manifest | Describes authentication fields and typed operations; implemented by a trusted plugin | No |
| Connection | One verified provider account for one Rat owner | No |
| Credential binding | Host-only pointer to the encrypted credential | Reference only |
| Grant | Persistent Rat-side permission ceiling for one connection | No |
| Connection set | Reusable selection of accounts, including multiple accounts for one plugin | No |
| Run selection | Selects and optionally narrows accounts for one run | No |

The API accepts a credential, but it does not accept claims about which account or permissions that
credential represents. The plugin verifies the credential against its fixed provider API and
derives the account label, tenant/subject identifiers, provider access, and provider scopes. Only a
successful verification creates the secret and connection metadata.

The credential value is never returned. It is not copied into a run request, Thing, DynamoDB record,
MicroVM launch payload, App Server tool schema, model-visible environment variable, URL, or log.

## 1. Discover what the deployment supports

Every UI, agent, and integration client starts with the same endpoint:

```http
GET /v1/integrations/plugins
```

A manifest describes the exact authentication fields and operations installed in that deployment:

```json
{
  "id": "stripe",
  "version": "1",
  "title": "Stripe",
  "authentication": [
    {
      "scheme": "api-key",
      "title": "Secret API key",
      "fields": [
        { "key": "api_key", "label": "Secret key", "secret": true }
      ]
    }
  ],
  "operations": [
    {
      "id": "stripe.customers.search",
      "kind": "search",
      "access": "read",
      "risk": "routine",
      "defaultApproval": "never"
    }
  ]
}
```

Consumers should render or request only the declared fields. Do not hard-code provider credential
forms separately from the manifest. If a plugin offers more than one authentication scheme, the
consumer asks the operator to choose one.

## 2. Connect and verify one account

For the CLI, create a short-lived, owner-readable credential file containing only the fields from
the selected authentication definition:

```bash
umask 077
printf '{"api_key":"replace-with-issued-key"}\n' > /secure/tmp/stripe.json

rat-things plugins
rat-things connect stripe \
  --credential-file /secure/tmp/stripe.json \
  --access read-only
rat-things connections
```

`connect` discovers the manifest, validates the exact field names, chooses the sole authentication
scheme when unambiguous, and defaults the Rat grant to `read-only`. Use `--auth-scheme oauth2` when
a plugin has several schemes. `--alias` is optional: Rat derives a readable alias from the verified
provider label and adds `-2`, `-3`, and so on when needed.

The equivalent API request is deliberately small:

```json
{
  "version": "1",
  "pluginId": "stripe",
  "authScheme": "api-key",
  "credential": {
    "api_key": "supplied-only-to-this-management-call"
  },
  "grant": {
    "version": "1",
    "preset": "read-only"
  }
}
```

The authenticated principal becomes the owner; callers cannot submit `ownerId`. The response
contains derived metadata and the initial grant, never the credential or vault reference:

```json
{
  "connection": {
    "version": "1",
    "connectionId": "...",
    "ownerId": "api:authenticated-principal",
    "pluginId": "stripe",
    "alias": "stripe-acme-shop",
    "label": "Acme Shop",
    "externalTenantId": "acct_...",
    "authorization": {
      "scheme": "api-key",
      "access": "full",
      "scopeModel": "unknown",
      "scopes": []
    },
    "status": "active",
    "createdAt": "2026-08-22T12:00:00.000Z",
    "updatedAt": "2026-08-22T12:00:00.000Z"
  },
  "grant": {
    "version": "1",
    "grantId": "...",
    "ownerId": "api:authenticated-principal",
    "connectionId": "...",
    "preset": "read-only"
  }
}
```

A rejected credential returns `400 invalid_request`, creates no secret, and is safe to correct and
resubmit. Provider identity is established before persistence, so callers cannot label an unrelated
token as another tenant or fabricate its scopes. Provider throttling, 5xx responses, and network
failure return retryable `503 integration_unavailable` rather than blaming the credential.

## 3. Connect multiple accounts

Run `connect` again for every account. Aliases are unique only within the Rat owner:

```bash
rat-things connect slack --auth-scheme oauth2 \
  --credential-file /secure/tmp/client-a.json --alias slack-client-a
rat-things connect slack --auth-scheme oauth2 \
  --credential-file /secure/tmp/client-b.json --alias slack-client-b
```

The accounts share a plugin implementation but never credentials or authority. An agent tool call
selects the exact account alias. If only one eligible account is configured as a default, the
generated tool schema can omit the account; ambiguous multi-account tools require an explicit alias.

Connection sets make a selection reusable:

```bash
rat-things connection-set --file /secure/config/customer-ops.json
```

```json
{
  "version": "1",
  "name": "customer-ops",
  "connections": ["slack-client-a", "slack-client-b", "stripe-acme-shop"],
  "defaults": {
    "support": "slack-client-a",
    "billing": "stripe-acme-shop"
  }
}
```

Use the set from a direct run:

```bash
rat-things --thread customer-ops \
  --profile small-business \
  --connection-set customer-ops \
  --connection slack-client-b=read-only \
  "Review support and billing exceptions"
```

Or place the same aliases/set in a versioned Thing. `rat-things thing-explain THING_ID` resolves the
accounts and shows why every operation is allowed or denied before the Thing is published.

## 4. Understand effective permission

An operation is available only when every applicable layer permits it:

1. The verified provider authorization permits the access level and required provider scopes.
2. The persistent connection grant permits the operation.
3. The selected capability profile does not forbid it.
4. A Thing or run-level selection may narrow it again.
5. Deny lists, expiry, resource constraints, and approval policy are enforced.

The effective permission is the intersection, never the union. A full-access provider key can be
exposed to Rat as read-only. A read-only provider token cannot be widened by a Rat grant.

| Rat preset | Eligible operation access |
| --- | --- |
| `read-only` | `read` |
| `read-write` | `read`, `write` |
| `full` | `read`, `write`, `full` |
| `custom` | IDs explicitly listed in `allowOperations` |

Provider and Rat permission remain separate. When a provider reports granular scopes, both layers
enforce them. When an API key is broad or the provider does not expose scope metadata, the
connection honestly records `coarse` or `unknown`; Rat still enforces its grant, but the provider
credential itself remains broad.

For tighter control, replace the persistent grant:

```bash
rat-things grant slack-client-a --file /secure/config/slack-client-a-grant.json
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

`resourceConstraints` match operation input fields before approval and before the credential is
read. Operations declare `never`, `on-request`, or `always` approval. An `always` write asks on every
call; an accepted request does not silently authorize a later write.

## 5. Rotate or revoke safely

Rotation uses the same credential-only file journey as connection setup:

```bash
rat-things rotate stripe-acme-shop --credential-file /secure/tmp/stripe-rotated.json
rat-things revoke stripe-old-account
```

Rat verifies a rotated credential before replacing the stored value and rejects it if its provider
tenant or subject differs from the existing connection. Revocation marks the connection inactive
and asks the vault to delete the credential. Existing run requests cannot bypass revocation because
connection status is checked again when an agent tool session is created.

The raw rotation API request is `{"version":"1","credential":{...}}`.

## Bring your own OAuth

Rat Things does not operate a universal OAuth client. A self-hosted console or embedded product owns
its provider application, redirect URL, consent screen, state/PKCE validation, code exchange,
refresh policy, and provider review. After consent, the host sends the issued token as the manifest's
credential field. Rat immediately verifies it and derives the account identity.

Hosted authorization redirects and automatic token refresh are not part of v1. API keys and
already-issued OAuth tokens are supported now. This keeps deployments independent and lets a host
use any account or group model without Rat implementing signup, organizations, or billing.

Never place a token in a command-line argument, webhook body, Thing, run request, or URL. Delete the
temporary credential file after a successful connection and keep OAuth exchange logs redacted.

## Source-bound permissions

A verified webhook source can select a preconfigured capability profile and/or connection set only
after provider signature verification:

```bash
rat-things bind-source --file /secure/config/client-channel-binding.json
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

Selectors match trusted normalized source fields. A binding does not change run ownership or embed
a credential. Source-binding creation is currently a trusted operator action; do not delegate it to
arbitrary tenants until the provider installation itself is authenticated.

## Built-in and fixture integrations

| Plugin | Operations | Availability |
| --- | --- | --- |
| Slack | API test, message search/post, reaction add | Built in |
| Stripe | Customer search, invoice list, refund create | Built in |
| Fixture CRM | Record search/create with two permission-distinct accounts | Tests only |

The HTTP adapters pin credential-free API base URLs, reject redirects and origin escapes, bound
request/response bodies, and attach credentials only inside trusted code. Fixture CRM is compiled
only when `INTEGRATION_PLUGIN_BASE_URLS` supplies its base URL. It exists to prove onboarding,
verified identity, provider scopes, multiple accounts, read/write intersection, approval, exact-once
provider mutation, and secret non-disclosure without depending on a customer's third-party account.

## Add a trusted integration

Integration plugins are trusted TypeScript adapters compiled into the MicroVM image:

1. Define an `IntegrationPluginManifest` in `src/plugins/integrations` with a lowercase plugin ID,
   authentication definitions, and namespaced operation IDs.
2. Implement `verifyCredential`. Call a fixed provider identity endpoint and return a bounded label,
   provider authorization, and stable tenant/subject IDs when available. Never trust those values
   from the connection-create request.
3. Define each operation's access, risk, default approval, required provider scopes, and closed JSON
   input schema.
4. Prefer `TrustedHttpIntegrationPlugin`: use a credential-free HTTPS base URL and construct only
   relative paths from validated inputs. Never let the model provide an origin.
5. Register the adapter in `src/plugins/integrations/builtins.ts` and rebuild the trusted image.
6. Add contract, simulation, LocalStack, and disposable live-AWS tests. Prove a read, an
   approval-gated write, a denied credential/scope, account selection, and absence of secret values.

Ingress signature parsing remains in `src/ingress`/`src/channels`; outbound result notification
remains in `src/delivery`. Agent-callable integration operations belong here. The architecture check
enforces those boundaries.

Arbitrary package loading, a marketplace, a visual workflow editor, hosted OAuth, and a broad app
catalog are intentionally deferred. The current contract is the extension point: one manifest,
one verifier, typed operations, and the same API for CLIs, agents, and product UIs.

For failures, follow [integration diagnostics](diagnostics.md#debug-an-integration-connection).
For consumer architecture and OAuth ownership, see [embedding and self-hosting](embedding.md).
