# Rat Things Guide

This repository is the standalone execution subsystem extracted from
`indubitably-serverless`.

## Boundaries

- `src/domain` owns stable run contracts and state transitions. It must not import AWS SDKs.
- `src/core` owns orchestration against ports. It must not know about webhook payload shapes.
- `src/identity` keeps actor, owner, source, destination, and credential subject distinct.
- `src/credentials` owns the host-side secret-reader contract and credential-value parsing.
- `src/ingress` authenticates and normalizes provider requests behind an ingress port.
- `src/delivery` resolves destinations and delivers results behind a delivery port.
- `src/execution` owns backend-neutral dispatch and the MicroVM executor registry.
- `src/plugins` validates trusted provider manifests and binds ingress/delivery capabilities.
- `src/adapters` owns AWS, DynamoDB delivery fencing, and execution-backend implementations.
- `src/channels` contains provider protocol parsing/signature helpers only.
- `src/app` is the composition root. No lower layer may import it.
- `src/lambdas` contains transport adapters only; business orchestration belongs below it.
- `src/runner` contains trusted orchestration that drops the actual agent process to a separate
  non-root UID inside Lambda MicroVMs.
- `infra/modules/agent-runner` is the reusable Terraform module; `infra/` is its dev/root example.

Keep provider ingress, agent execution, and result notification as separate stages. Never put
provider tokens in run requests, DynamoDB records, task overrides, logs, or repository URLs.
`npm run architecture:check` enforces the dependency direction above.

## Commands

```bash
npm ci
npm run check
npm run smoke:local
npm run test:e2e:localstack
```

Terraform requires packaged Lambda artifacts:

```bash
npm run package
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

The Lambda functions and MicroVM image are ARM64. Container builds must use `linux/arm64`.

## Safety invariants

- Every unauthenticated webhook route validates the provider signature before parsing or enqueueing.
- The API-derived principal owns a run; callers cannot choose an arbitrary owner ID.
- Run state changes use conditional writes and the transition table in `src/domain/state.ts`.
- Repository clone URLs are HTTPS and host-allowlisted.
- Agent commands are built as argument arrays and are never passed through a shell.
- Workers have no public or user-facing ingress. The MicroVM image listens only on the
  service-required lifecycle port; conversation continuation requires an AWS-issued proxy token.
- `danger-full-access` is accepted only because the outer MicroVM is the isolation boundary.
- Results and prompts live in encrypted S3; DynamoDB stores references and bounded summaries.

## Verification

Run `npm run check` after code or Terraform changes. Lambda MicroVM provisioning is an explicit
opt-in operation and must not run during ordinary tests.
