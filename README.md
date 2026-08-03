# Rat Things

<p align="center">
  <img src="assets/rat-things-hero.jpg" alt="An original cybernetic guard dog emerging from a refrigerated hutch in a dark server facility" width="100%">
</p>

<p align="center">
  <strong>One prompt. One disposable MicroVM. Durable results.</strong>
</p>

<p align="center">
  <a href="https://github.com/gpazo/Rat-Things/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/gpazo/Rat-Things/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0b0f14.svg"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-2f855a.svg">
  <img alt="AWS Lambda MicroVM" src="https://img.shields.io/badge/runtime-AWS%20Lambda%20MicroVM-ff9900.svg">
  <img alt="Engineering preview" src="https://img.shields.io/badge/status-engineering%20preview-1d9bf0.svg">
</p>

<p align="center">
  <a href="https://gpazo.github.io/Rat-Things/">Website</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="docs/microsoft-teams.md">Connect Microsoft Teams</a> ·
  <a href="docs/status-and-roadmap.md">Validation status</a>
</p>

Rat Things is an AWS-native agent runner. It accepts authenticated API requests and signed GitHub,
GitLab, or chat webhooks; executes each run in its own AWS Lambda MicroVM; stores durable artifacts;
and delivers the result back to the originating thread. Microsoft Teams is the preferred chat
surface, with Slack available as an optional adapter.

The subsystem is deliberately narrow: it owns agent execution, not your product's application
logic. There is no ECS worker service, customer VPC, NAT gateway, or long-lived agent container.

> [!WARNING]
> Rat Things is an engineering preview. Its deterministic workflow and minimal real-Codex paths
> have been validated locally and in disposable AWS infrastructure, but it has not completed a
> production security review, sustained-load exercise, or multi-tenant hardening. Lambda MicroVMs
> are a new AWS service available only in selected Regions.

## Why Rat Things?

- **Isolation per run** — one Lambda MicroVM is launched for one job and explicitly terminated.
- **Durable orchestration** — DynamoDB, S3, SQS, Streams, and EventBridge hold state outside compute.
- **Webhook to result** — signed GitHub, GitLab, Teams, and optional Slack paths share one run model.
- **Codex-first execution** — ChatGPT account auth for trusted local work; short-term Bedrock auth in AWS.
- **Provider-neutral boundaries** — ingress, identity, credentials, execution, delivery, and plugins
  are separate TypeScript modules inspired by the architectural strengths of Sentry Junior.
- **Disposable validation** — LocalStack and live-AWS harnesses exercise the complete data flow and
  tear down temporary infrastructure.

## Data flow

```text
signed webhook / IAM-authenticated API
                  |
                  v
       DynamoDB + encrypted S3 -> SQS -> dispatcher
                                             |
                                             v
                                  one Lambda MicroVM
                                             |
                                             v
                         S3 result + DynamoDB state
                                             |
                                             v
                         EventBridge -> provider result
```

Trusted orchestration resolves secrets and performs repository checkout before launching Codex as
UID 10001 with a sanitized environment. Prompts and repository credentials are never placed in the
MicroVM launch payload.

## Architecture

### C1 — System context

The system boundary is intentionally small: authenticated callers and provider webhooks enter Rat
Things; isolated agent execution calls a configured model provider; results return to the source.

![Rat Things C4 system context](docs/c4-system-context.png)

### C2 — Agent runtime containers

The runtime container view follows a run from ingress through durable orchestration, isolated
execution, artifact storage, and result delivery.

![Rat Things C4 agent runtime containers](docs/c4-runtime-containers.png)

### C2 — LocalStack test harness

LocalStack validates signed ingress, state, queues, events, delivery fencing, and captured egress
without model tokens. Because LocalStack does not implement Lambda MicroVM lifecycle APIs, its agent
process is host-run and labeled `microvm`; isolation is validated in AWS.

![Rat Things C4 LocalStack test harness](docs/c4-localstack-test-harness-containers.png)

### C2 — Live AWS test harness

The disposable AWS harness deploys the real control plane and Lambda MicroVM image, exercises signed
webhooks and repository-backed execution, validates outputs and failure queues, and destroys the
tagged stack from an exit trap.

![Rat Things C4 live AWS test harness](docs/c4-live-aws-test-harness-containers.png)

## Quick start

Requirements: Node.js 20+, npm, and Git.

```bash
git clone https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm ci
npm run check
npm run smoke:local
```

The default smoke test uses the deterministic mock driver. It does not call AWS or a model.

### Use your local Codex subscription

Sign in once with `codex login`, then run Codex through this repository's pinned CLI:

```bash
npx tsx src/cli.ts local \
  --driver codex \
  --codex-auth chatgpt \
  --sandbox read-only \
  --events \
  --prompt "Inspect package.json and summarize this project"
```

To intentionally validate shell-tool network access as well as file access:

```bash
npx tsx src/cli.ts local \
  --driver codex \
  --codex-auth chatgpt \
  --sandbox workspace-write \
  --network \
  --events \
  --prompt "Read package.json, report pwd, then fetch https://example.com"
```

`--events` emits the complete Codex JSONL protocol, including command execution and usage events.
Command networking is off by default and requires the explicit `--network` plus `workspace-write`
combination.

## Authentication modes

| Mode | Intended use | Credential boundary |
| --- | --- | --- |
| `chatgpt` | Trusted local runs | Reuses the device's cached `codex login` session and included subscription access |
| `bedrock` | Unattended AWS runs | Trusted orchestration mints a bounded short-term Bedrock token and passes only that token to Codex |
| `mock` driver | Tests and infrastructure validation | No model credential or token spend |

Authentication mode is deployment policy. A webhook or run request cannot select it. Personal
`~/.codex/auth.json` files are never copied into AWS because repository-controlled agent code could
steal the reusable account credentials.

## End-to-end validation

### LocalStack

Docker is required for this path:

```bash
npm run test:e2e:localstack
```

The test covers signed GitHub/GitLab ingress and a complete signed Teams path through LocalStack
Secrets Manager, S3, DynamoDB Streams, SQS, EventBridge, durable delivery fencing, and WireMock
egress.

To exercise the same Teams path with your signed-in Codex subscription and verify that the outbound
reply retains the exact source conversation and activity reference:

```bash
npm exec -- codex login
npm run test:e2e:teams:codex
```

This is a local Teams simulation: WireMock captures the trusted threaded-reply gateway contract.
It does not yet validate Microsoft Entra/Bot authentication or delivery into a live Teams tenant.

### Disposable AWS

Terraform, AWS credentials, a supported Region, and an available Lambda MicroVM base-image version
are required:

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<available pinned version>" \
npm run test:e2e:aws
```

The default live suite uses the mock driver and spends no model tokens. Add one intentionally small
Codex-on-Bedrock canary with `AWS_E2E_REAL_CODEX=true`. The harness always attempts teardown from an
exit trap; the customer-managed KMS key is disabled and enters AWS's mandatory pending-deletion
period.

## Repository layout

```text
src/app/          composition root
src/ingress/      authenticated provider normalization
src/identity/     actor, owner, and source contexts
src/credentials/  trusted secret resolution
src/execution/    MicroVM execution boundary
src/runner/       workspace and Codex process runtime
src/delivery/     durable destination delivery
src/plugins/      built-in provider manifests
infra/            reusable AWS Terraform
microvm/          managed image and lifecycle server
testing/          LocalStack and live-AWS harnesses
docs/             architecture, security, API, and runbooks
site/             GitHub Pages source
```

`npm run architecture:check` enforces the intended dependency direction. Plugins cannot select the
execution mechanism, mutate run state, read arbitrary artifacts, or own credential values.

## Security model

Treat every prompt, webhook field, repository byte, branch name, model event, and generated response
as untrusted. The Lambda MicroVM is the code-execution boundary; Codex's sandbox is defense in depth.

Before production, Rat Things still needs independent IAM and malicious-repository review, budget
and concurrency limits, outbound policy, short-lived source-control credentials, output redaction,
destination authorization, failure injection, and a production Teams bot gateway.

Read the complete [security and threat model](docs/security.md) and [status and roadmap](docs/status-and-roadmap.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Control API](docs/api.md)
- [Connect Microsoft Teams](docs/microsoft-teams.md)
- [Channels](docs/channels.md)
- [Provider plugin model](docs/plugins.md)
- [Development and deployment](docs/development-and-deployment.md)
- [Security model](docs/security.md)
- [Operational runbook](docs/runbook.md)
- [Status and roadmap](docs/status-and-roadmap.md)

## Name and provenance

The name refers to the semi-autonomous cybernetic guard dogs in Neal Stephenson's *Snow Crash*—fast,
watchful systems that wait in cooled hutches until called into action. The hero illustration is
original project artwork based only on that broad literary concept; it is not official *Snow Crash*
artwork and does not reproduce a book cover or adaptation.

Implementation design used immutable revisions of the [AWS Lambda MicroVM sample at
`2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm)
and [Sentry Junior at
`cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274).
Neither project is vendored. See [NOTICE](NOTICE) for attribution.

Rat Things is an independent open-source project and is not affiliated with Neal Stephenson, the
publishers of *Snow Crash*, AWS, Sentry, GitHub, GitLab, Microsoft, Slack, or OpenAI.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
