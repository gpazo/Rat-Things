# How Rat Things operates

Rat Things is a self-hostable, headless automation backend for agents, applications, CLIs, and
provider events. A host installs one independent deployment, supplies identity and OAuth, and
decides whether that deployment serves one person, a team, or users of another product. Rat Things
supplies the common automation contract and isolated execution runtime; it does not require a
Rat-operated control plane or user interface.

> Once this narrow journey is delightful and stable, expand it.

## The narrow journey

Every consumer uses the same path:

```text
install -> discover -> connect an account -> define a Thing -> explain -> run -> observe
```

1. **Install** one deployment in the host's AWS account and choose its authentication boundary.
2. **Discover** its OpenAPI contract, schemas, capability profiles, and installed integration
   manifests instead of assuming what it supports.
3. **Connect an account** with the fields declared by an integration manifest. Rat verifies the
   credential with the provider, derives the account identity and provider permissions, then stores
   the credential outside run state.
4. **Define a Thing** containing reusable intent, a trigger, a capability profile, account
   selections, and delivery—never credential values.
5. **Explain before running.** Rat resolves the selected accounts and shows effective permissions,
   approval requirements, and blocking diagnostics without exposing secrets.
6. **Run** the Thing manually, on its interval, or from an authenticated event. The resulting run
   uses the same owner-scoped asynchronous contract regardless of the consumer that invoked it.
7. **Observe and debug** through stable run states, events, approval requests, retained files,
   publications, error envelopes, and trace IDs.

The CLI is one consumer of this contract, not a privileged path. An operator console, another
agent, a SaaS backend, and a signed webhook can use the same primitives.

## The core objects

| Product term | Meaning | Important boundary |
| --- | --- | --- |
| **Thing** | A versioned, reusable agent automation | Contains intent and account references, never credentials |
| **Integration** | A trusted manifest plus typed operations for an external service | User-facing term; the implementation is a trusted plugin |
| **Account** | One provider-verified identity connected by one Rat owner | The API object is a connection; the provider supplies its identity |
| **Grant** | The owner's persistent Rat-side permission ceiling for an account | Can narrow provider authority, never widen it |
| **Account set** | A reusable group of accounts, including several accounts for one integration | The API calls this a connection set |
| **Run** | One durable execution of a Thing or lower-level request | Asynchronous, owner-scoped, observable, and idempotent |

Product documentation uses **integration**, **account**, and **account set**. Plugin, connection,
credential binding, and broker are implementation or API-reference terms used when their precision
matters.

## Permission is an intersection

An operation is available only when every authority layer permits it:

```text
deployment/profile ceiling
       ∩ provider authorization
       ∩ persistent account grant
       ∩ Thing or run selection
       ∩ operation and resource constraints
       = effective permission
```

`read-only`, `read-write`, and `full` are useful presets; operation allow/deny lists and resource
constraints provide narrower control. Approval is an additional decision point for a permitted
operation. Approving an operation does not widen any permission layer.

If a provider cannot report fine-grained scopes, Rat records that uncertainty rather than inventing
precision. A host may still apply a narrower Rat grant. Use `thing-explain` before enabling a Thing
to see the resolved intersection for every selected account and operation.

## The host owns identity and OAuth

Rat Things deliberately does not decide the host's product or tenancy model.

- The host authenticates people and services and supplies a trusted principal.
- Rat derives the owner from that principal; callers cannot choose another owner ID.
- The host owns OAuth applications, redirect URLs, consent screens, callback handling, and refresh
  policy.
- Rat accepts the resulting credential through the manifest-defined connection contract, verifies
  it, stores it in the deployment's secret vault, and never returns it.
- One deployment may serve one owner or many owners. Rat enforces owner isolation; the host decides
  how those owners map to people, organizations, or customers.

This is **bring your own OAuth**, not a hosted OAuth service. An embedded product may complete OAuth
in its own backend and pass the resulting credential object to Rat over the authenticated control
API. A personal deployment may use the same API through the CLI and a credential-only file.

## Consumers build the experience

Rat Things publishes the primitives needed to build a simple interface without duplicating
provider-specific logic:

- `/.well-known/rat-things` describes the deployment and links its contracts;
- `/openapi.json` describes installed HTTP operations;
- `/v1/integrations/plugins` declares authentication fields and typed provider operations;
- Thing JSON Schemas support forms, editor completion, validation, and agent tool definitions;
- `thing-explain` resolves accounts and permissions before execution; and
- stable errors, run states, events, files, and publications support progress and recovery UX.

A consumer should render manifests, preserve opaque Rat IDs, and let Rat remain authoritative for
ownership, provider verification, permission resolution, and run state. It should not maintain a
second catalog of credential fields or infer account authority from a user-selected label.

## Intentionally outside the narrow journey

The first product path does not require a visual workflow editor, public marketplace, central
tenant service, Rat-hosted OAuth callbacks, arbitrary runtime package loading, or enterprise
administration suite. Those features can be considered after the discover-connect-explain-run path
is consistently simple and reliable.

Browser computer use, conversations, files, publications, schedules, and channels extend what a
Thing can do. They remain capabilities behind the same Thing, permission, approval, run, and
evidence boundaries rather than separate product models.

## Continue by task

- [Build and run a Thing](things.md)
- [Connect accounts and understand permissions](plugins.md)
- [Embed Rat Things in another product](embedding.md)
- [Self-host a deployment](development-and-deployment.md)
- [Debug the public primitives](diagnostics.md)
- [Use the control API](api.md)
- [Understand the isolation architecture](architecture.md)
- [Review what has been live validated](status-and-roadmap.md)
