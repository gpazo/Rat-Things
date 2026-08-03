# Indubitably Agent Runtime

An AWS-native subsystem for accepting agent runs, executing each run in an isolated compute
environment, retaining its artifacts, and delivering the result to the channel that requested it.
GitHub and GitLab webhooks are first-class ingress paths; Microsoft Teams is the preferred chat
surface, with Slack available as an optional adapter.

> **Maturity: engineering preview.** The contracts and core orchestration are implemented, but this
> repository has not completed a production security review or sustained-load exercise. ECS is the
> baseline backend. AWS Lambda MicroVMs are a separate, opt-in backend built on a service launched in
> June 2026 and available only in selected Regions. The current Teams integration is a bridge, not the
> intended production Teams bot. See [status and roadmap](docs/status-and-roadmap.md).

This repository is a copy/extraction target: it does not require modifying or deleting agent code in
`indubitably-serverless`. Migration is deliberately a parallel-deploy and cutover process.

## What is here

- A versioned `POST /v1/runs` control contract with idempotent submission, status, listing, and
  cancellation.
- Signed GitHub, GitLab, Teams, and optional Slack webhook adapters.
- Durable run state in DynamoDB, large inputs/results in S3, SQS dispatch, and EventBridge completion
  events.
- One isolated execution environment per run:
  - **ECS:** one ARM64 Fargate task started with `RunTask`; this is not a long-lived ECS service.
  - **MicroVM:** one AWS Lambda MicroVM started with `RunMicrovm`; image and network connector
    provisioning are explicit and opt-in.
- A shared worker contract for Codex, Claude Code, and a deterministic mock driver.
- A deployment sandbox policy that allows `read-only` and `workspace-write` by default and rejects
  `danger-full-access` unless explicitly enabled.
- Result delivery to the originating GitHub/GitLab thread, a Teams Workflow URL, or Slack.
- A reusable Terraform module plus a root deployment example.

The important system boundary is:

```text
control API / signed webhook
            |
            v
     DynamoDB + encrypted S3 ----> SQS ----> dispatcher
                                                |
                                 +--------------+--------------+
                                 |                             |
                            ECS Fargate                 Lambda MicroVM
                                 |                             |
                                 +-------------+---------------+
                                               |
                                S3 result + EventBridge state
                                               |
                               GitHub / GitLab / Teams / Slack
```

The worker has no user-facing or workload ingress. The MicroVM image does expose the service-required
lifecycle-hook listener inside its managed environment; it is not an agent API. The prompt and
repository credential are not passed in ECS task overrides or the MicroVM hook payload. Trusted
orchestration resolves the stored run by ID, performs the privileged checkout, and then launches the
agent as UID 10001 with a sanitized environment.

## Three identities, never one

The runtime deliberately keeps these concepts separate:

1. **Source identity** records who or what caused a run (`api`, `github`, `gitlab`, `teams`, or
   `slack`) and establishes run ownership/idempotency.
2. **Destination identity** says where results should be published. `source` means “resolve from the
   trusted source metadata”; a named Teams/Slack route is delivery configuration, not an owner.
3. **Credential identity** is the least-privileged AWS role or Secrets Manager secret used to clone a
   repository, invoke a model, or post a result. A credential never decides ownership or destination.

Do not derive one identity from another, accept a caller-supplied owner, or put credentials in a
repository URL, run body, task override, log field, or destination route. The detailed invariants are
in [the security model](docs/security.md).

## Local quick start

Prerequisites are Node.js 20+, npm, Git, and (for real drivers) an installed/authenticated Codex or
Claude Code CLI. Terraform and Docker are needed only for infrastructure and image work.

```bash
npm ci
npm run typecheck
npm test
npm run smoke:local
```

The local smoke command uses the mock driver and does not call AWS or a model provider. It exercises
the same request validation and driver boundary used by remote workers.

For the complete signed-webhook-to-result workflow against disposable AWS-compatible services, run:

```bash
npm run test:e2e:localstack
```

That suite verifies signed GitHub and GitLab ingress plus a complete signed Teams path through
Secrets Manager, S3, DynamoDB Streams, SQS, dispatcher and worker behavior, EventBridge routing,
durable delivery fencing, and Teams egress through WireMock. It uses the real mock-agent worker but
a test-only ECS launch reference, so it does not claim to test
Fargate or Lambda MicroVM isolation. See [the LocalStack harness](testing/README.md) for its exact
boundary and interactive commands.

For a short-lived validation against real AWS—including API Gateway, Lambda, SQS, DynamoDB Streams,
EventBridge, ECR, and an ARM64 ECS Fargate worker—run:

```bash
npm run test:e2e:aws
```

The command creates a uniquely named and tagged stack, uses the deterministic mock agent so it does
not spend model tokens, runs control-API plus signed GitHub/GitLab flows, and destroys the stack from
an exit trap whether the tests pass or fail. The default ECS-only mode avoids NAT gateways and paid
interface endpoints. An opt-in mode also builds and runs a real Lambda MicroVM, which requires a
pinned managed base-image version and temporarily creates a NAT gateway for repository egress. See
[the live AWS harness](testing/aws/README.md) for both commands and teardown guarantees.

To build deployable Lambda artifacts and the ARM64 worker image:

```bash
npm run package
npm run docker:build
```

For an authenticated remote run, deploy the stack and use the mock-driver command in
[development and deployment](docs/development-and-deployment.md). The
[`examples/run-request.json`](examples/run-request.json) file is an illustrative contract fixture;
replace its example repository URL before submitting it. Do not enable the MicroVM backend until ECS
can complete the same request.

## Documentation

- [Architecture and execution backends](docs/architecture.md)
- [Control API and v1 run contract](docs/api.md)
- [GitHub, GitLab, Teams, and Slack](docs/channels.md)
- [Development, deployment, and migration](docs/development-and-deployment.md)
- [Security and threat model](docs/security.md)
- [Operational runbook](docs/runbook.md)
- [Status and roadmap](docs/status-and-roadmap.md)

## Reference implementations and service documentation

Design work used immutable reference-project revisions so later upstream changes do not silently
change the provenance of this repository:

- AWS sample, [Claude Code on AWS Lambda MicroVMs at
  `2a574ea`](https://github.com/aws-samples/anthropic-on-aws/tree/2a574ea941f44e36e9066dea7b131131139162e4/claude-code-on-lambda-microvm).
- Sentry, [Junior at
  `cc9bd53`](https://github.com/getsentry/junior/tree/cc9bd538564639345717caf4a92a3ddef37f3274).

The implementation is its own subsystem rather than a deployment of either project. The AWS sample
informed MicroVM image/lifecycle provisioning. Junior informed the separation between channel
ingress, orchestration, execution, and delivery. Attribution is recorded in [`NOTICE`](NOTICE).

Authoritative service references:

- [AWS Lambda MicroVMs guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Amazon ECS `RunTask`](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html)
- [Microsoft Teams SDK](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
