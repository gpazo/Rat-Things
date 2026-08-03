# Provider plugin model

The runtime uses a small, trusted plugin contract to keep provider behavior outside orchestration.
It adopts the useful host/plugin boundary from Sentry Junior without embedding Junior or loading
arbitrary npm packages.

## Contract

One `RuntimePlugin` has:

- a validated manifest with a unique lowercase name, version, description, and provider;
- at most one webhook-ingress adapter for that provider; and
- at most one result-delivery adapter for that provider.

The registry rejects duplicate names, duplicate provider capabilities, and manifest/adapter
mismatches before handling work. The composition root explicitly registers the built-in GitHub,
GitLab, Microsoft Teams, and Slack plugins.

## Authority boundaries

Plugins receive only the data required for their capability:

- Ingress receives the raw body and headers. It authenticates before JSON normalization and returns
  bounded run work with explicit actor, owner, source, and credential-subject context.
- The ingress service overwrites any request source with the trusted plugin source before submission.
- Delivery receives a resolved destination context, stored request, run record, and bounded result
  body only after the host claims the DynamoDB delivery fence.
- Credential values are resolved through the host-owned `CredentialBroker`. Plugins never receive a
  Secrets Manager client or select an arbitrary credential subject.
- Plugins cannot select the execution mechanism, mutate run state, read arbitrary artifacts, or import
  the Lambda transport/composition layers.

`npm run architecture:check` enforces dependency direction in addition to TypeScript interfaces.

## Adding a provider

1. Add pure payload/signature helpers under `src/channels` when needed.
2. Implement `WebhookIngressAdapter` under `src/ingress/providers`.
3. Implement `DeliveryAdapter` under `src/delivery/providers` when the provider supports egress.
4. Register one manifest in `src/plugins/builtins.ts` and supply only host-owned options from
   `src/app/composition.ts`.
5. Add contract tests for authentication, normalization, trusted context, delivery routing, retries,
   and duplicate registration.
6. Add the Lambda/Terraform transport only after the provider-neutral contracts pass.

## Deliberate limits

This is not yet Junior's general plugin ecosystem. There is no package discovery, dynamic code
loading, plugin database migration, arbitrary tool registration, OAuth continuation, resumable
conversation, or plugin-controlled UI. Those capabilities should be introduced only when a concrete
runtime requirement justifies their authority and lifecycle cost.
