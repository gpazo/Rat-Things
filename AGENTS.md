# Agent Runtime Guide

This repository is the standalone execution subsystem extracted from
`indubitably-serverless`.

## Boundaries

- `src/domain` owns stable run contracts and state transitions. It must not import AWS SDKs.
- `src/core` owns orchestration against ports. It must not know about webhook payload shapes.
- `src/adapters` owns AWS and execution-backend implementations.
- `src/channels` owns GitHub, GitLab, Microsoft Teams, and Slack translation only.
- `src/runner` contains trusted orchestration that drops the actual agent process to a separate
  non-root UID inside both ECS and Lambda MicroVMs.
- `infra/modules/agent-runner` is the reusable Terraform module; `infra/` is its dev/root example.

Keep provider ingress, agent execution, and result notification as separate stages. Never put
provider tokens in run requests, DynamoDB records, task overrides, logs, or repository URLs.

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

The production task and Lambda architectures are ARM64. Docker builds must use `linux/arm64`.

## Safety invariants

- Every unauthenticated webhook route validates the provider signature before parsing or enqueueing.
- The API-derived principal owns a run; callers cannot choose an arbitrary owner ID.
- Run state changes use conditional writes and the transition table in `src/domain/state.ts`.
- Repository clone URLs are HTTPS and host-allowlisted.
- Agent commands are built as argument arrays and are never passed through a shell.
- Workers have no user-facing or workload ingress. The MicroVM image listens only on the
  service-required lifecycle-hook port inside the managed MicroVM environment.
- `danger-full-access` is accepted only because the outer ECS task or MicroVM is the isolation boundary.
- Results and prompts live in encrypted S3; DynamoDB stores references and bounded summaries.

## Verification

Run `npm run check` after code or Terraform changes. Run `npm run docker:build` after worker-image
changes when Docker is available. Lambda MicroVM provisioning is an explicit opt-in operation and
must not run during ordinary tests.
