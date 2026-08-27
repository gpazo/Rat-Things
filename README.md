# Rat Things

<p align="center">
  <img src="assets/rat-things-hero.jpg" alt="An original cybernetic guard dog emerging from a refrigerated hutch in a dark server facility" width="100%">
</p>

<p align="center">
  <strong>The open-source backend for cloud agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/gpazo/Rat-Things/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/gpazo/Rat-Things/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0b0f14.svg"></a>
  <img alt="Node.js 22.20 or newer" src="https://img.shields.io/badge/node-%3E%3D22.20-2f855a.svg">
  <img alt="AWS Lambda MicroVM" src="https://img.shields.io/badge/runtime-AWS%20Lambda%20MicroVM-ff9900.svg">
  <img alt="Engineering preview" src="https://img.shields.io/badge/status-engineering%20preview-1d9bf0.svg">
</p>

<p align="center">
  <a href="https://gpazo.github.io/Rat-Things/">Website</a> ·
  <a href="https://gpazo.github.io/Rat-Things/docs/">Documentation</a> ·
  <a href="docs/quickstart.md">AWS quickstart</a> ·
  <a href="docs/agents.md">Agent guide</a> ·
  <a href="https://gpazo.github.io/Rat-Things/llms.txt">llms.txt</a> ·
  <a href="docs/status-and-roadmap.md">Current status</a>
</p>

Rat Things is a self-hosted backend for running tool-capable agents in isolated AWS Lambda
MicroVMs. It gives products, CLIs, other agents, schedules, and signed provider events the same
owner-scoped API, reusable **Things**, durable **Runs**, conversations, and generated files.

There is no central Rat Things service. The host owns identity, OAuth applications, credentials,
data, infrastructure, and the user experience. Rat verifies connected accounts, resolves a fixed
capability envelope before each Run, and keeps provider secrets out of Thing definitions, Run
records, logs, and launch payloads.

> [!WARNING]
> Rat Things is an engineering preview. Its deterministic workflows and bounded real-Codex paths
> have passed disposable live-AWS validation, but the project has not completed a penetration test,
> sustained-load exercise, disaster-recovery proof, or untrusted multi-tenant hardening.

## Start with one path

### Try Codex locally

On a trusted device, use the official ChatGPT sign-in. This path does not copy a reusable account
credential into AWS:

```bash
npm ci
npm run codex:login
npm run rat-things -- local "Summarize this repository"
```

Read [Use your Codex subscription](docs/codex-subscription.md) for sandbox, authentication, and
headless-login details.

### Deploy the bounded AWS proof

With Node 22.20+, Git, Terraform, AWS credentials, Lambda MicroVM capacity, and Bedrock access ready:

```bash
git clone --depth 1 --branch golden-path-v1.0.0 https://github.com/gpazo/Rat-Things.git
cd Rat-Things
test "$(git rev-parse HEAD)" = "f1c5487f1eb0c1bbf778a75fea939f4474ee68ff"
npm run quickstart:aws -- \
  --profile rat-things-sandbox \
  --region us-west-2
```

The command performs a no-write preflight, deploys, tests an exact Thing draft, activates that
revision, runs it again, and retains evidence. The ten-minute measurement starts at
`quickstart:aws`; installing host tools and obtaining AWS quota/service access happens first. The
golden path intentionally leaves S3 Files, hosted OAuth, schedules, and external sharing disabled.

Use the saved deployment context to inspect or remove the same target:

```bash
npm run quickstart:aws -- status
npm run quickstart:aws -- destroy
```

Read the [AWS-ready quickstart](docs/quickstart.md) before using a privileged account.

## What Rat Things provides

- **Reusable Things** — test an immutable draft, then activate one exact revision for manual, rate,
  or cron execution.
- **Verified accounts** — connect several accounts per integration, derive their provider identity
  and authority, and narrow each grant before use.
- **Fixed permissions** — the deployment profile, provider authorization, account grant, Thing/Run
  selection, IAM, networking, operations, and resources intersect before launch. Inside the result
  the agent is autonomous; outside it, a tool is absent or denied. There is no mid-Run approval
  path.
- **Isolated tools** — shell, Git, filesystem, policy-controlled networking, and browser computer
  use run as an unprivileged process inside a dedicated Firecracker-backed guest. Owners can view
  the live browser, take temporary control, and turn a redacted demonstration into a draft Thing.
- **Durable conversations and files** — searchable transcripts, replies, reactions, questions,
  uploads, generated files, and lifecycle state survive clients and compute. With S3 Files enabled,
  replacement compute also restores the exact native Codex state and workspace.
- **One embeddable contract** — installed discovery, OpenAPI, JSON Schemas, integration manifests,
  capability profiles, and stable errors support CLIs, products, and other agents.

The local reference console exercises the public conversation, live-computer, and Thing APIs; it is
not a hosted product or a second execution path. Its resizable three-pane workspace keeps the
conversation list, transcript, active Run, isolated browser, collected sources, and human-readable
activity together. Operators can watch, steer, stop, temporarily take browser control, and return
control without widening the Run's fixed capability envelope.

<p align="center">
  <a href="assets/conversation-console-live-browser.png"><img src="assets/conversation-console-live-browser.png" alt="Rat Things three-pane reference console during a live AWS NVIDIA earnings Run, with active progress, durable conversation, and isolated browser takeover" width="900"></a>
</p>

The screenshot is from a disposable live-AWS real-Codex Run against NVIDIA's official Q2 FY27
earnings release. The complete client journey passed in 2.8 minutes and the 234-resource stack was
destroyed afterward.

The CLI exposes the same durable conversation primitives without requiring the console:

```bash
rat-things conversations list
rat-things conversations search "NVIDIA earnings"
rat-things conversation show PUBLIC_CONVERSATION_ID
rat-things chat --thread earnings --attach report.pdf --reply-to MESSAGE_ID \
  "Compare this with the previous quarter"
rat-things watch RUN_ID --follow
```

List and search return an opaque public conversation ID for transcript, organization, reaction, and
source commands. `conversation sources` pages the complete indexed transcript, labels transcript
links as claims rather than verified visits, and reads durable files through the same opaque ID.
API-created conversations also return their caller-chosen thread key; use that key with
`chat --thread` to continue work. `watch` presents human-readable activity by default. A single
`--json` poll is one JSON document; `--follow --json` is JSONL snapshots; `--raw` is JSONL activity
cards. The CLI rejects unknown options, extra fixed operands, and conflicting output modes before
making a request.

Run `npm run smoke:conversation-cli` for a safe automated verification of the advertised
conversation surface. It starts a disposable loopback fixture, exercises six black-box workflows,
prints their pass/fail names, and exits; it is not an interactive mock server and does not create AWS
resources.

## Mental model

| Term | Meaning |
| --- | --- |
| **Thing** | Reusable, revisioned agent definition without credentials |
| **Run** | One accepted asynchronous execution receipt |
| **Conversation** | Durable continuity boundary for related messages and files |
| **Thread** | Caller/provider key that selects a conversation |
| **Integration / account** | Human-facing external-service contract and one verified provider identity |

Every accepted path returns a Run:

```text
IAM API / signed event / schedule
              |
              v
  DynamoDB + encrypted S3 -> SQS -> trusted coordination
                                      |
                                      v
                         Lambda MicroVM + Codex
                                      |
                                      v
                    result + files + delivery
```

DynamoDB holds bounded coordination state and summaries. Encrypted S3 holds immutable prompts,
events, results, uploads, and generated files. Optional S3 Files mounts conversation-scoped native
Codex state and workspace bytes for replacement-compute restoration. Public projections omit owner
principals, storage coordinates, MicroVM IDs, native thread IDs, and credential bindings.

Read [How Rat Things operates](docs/operating-model.md), [Architecture](docs/architecture.md), and
[The capability envelope](docs/capability-envelope.md) for the complete model.

## Documentation by task

- [Deploy the AWS golden path](docs/quickstart.md)
- [Connect an agent to an existing deployment](docs/agents.md)
- [Build, test, activate, and schedule a Thing](docs/things.md)
- [Connect accounts and understand effective permission](docs/plugins.md)
- [Use durable conversations](docs/conversations.md)
- [Retain, view, and share files](docs/sharing-work.md)
- [Embed the API in another product](docs/embedding.md)
- [Operate and diagnose a deployment](docs/diagnostics.md)
- [Review the control API](docs/api.md)
- [Review security boundaries and production gates](docs/security.md)
- [Inspect current validation and known gaps](docs/status-and-roadmap.md)

Agents should begin with installed `/.well-known/rat-things`, then follow
[docs/agents.md](docs/agents.md). The generated [llms.txt](https://gpazo.github.io/Rat-Things/llms.txt)
is progressive and normative; competitive research and historical validation diaries are excluded
from the agent corpus.

## Develop and verify

```bash
npm ci
npm run check
npm run smoke:local
npm run test:e2e:localstack
```

`npm run check` enforces architecture direction, TypeScript, tests, packaging, generated-site links,
Terraform formatting, and validation. Lambda MicroVM provisioning and live AWS tests are explicit
opt-ins; ordinary tests do not create cloud resources.

Key directories:

```text
src/domain       stable contracts and state transitions
src/core         orchestration against ports
src/conversation durable mailbox and conversation services
src/runner       trusted runner and non-root agent launch
src/adapters     AWS and execution implementations
src/lambdas      transport adapters
infra/           reusable module plus development root
console/         local reference conversation client
docs/            human, agent, operator, and API guides
testing/         deterministic LocalStack and disposable AWS harnesses
```

See [Development, deployment, and migration](docs/development-and-deployment.md) and the
[operational runbook](docs/runbook.md) for deeper procedures.

## Security posture

The outer MicroVM is the isolation boundary. `danger-full-access` may be admitted inside that guest,
but it does not grant a new host identity, credential, network route, connected-account operation,
or AWS permission. Provider ingress, agent execution, and result delivery remain separate stages.

Before production use, complete the open gates in [Security and threat model](docs/security.md):
rate/concurrency/model budgets, output and destination policy, audited egress, failure drills,
release provenance, and an independent cross-owner/IAM/snapshot/repository/SSRF review.

## Name, provenance, and license

The name is inspired by the broad literary concept of semi-autonomous guard units in Neal
Stephenson's *Snow Crash*. The implementation is independent and is not affiliated with or endorsed
by Neal Stephenson or the novel's publishers. Upstream architectural references and notices are in
[`NOTICE`](NOTICE).

Licensed under the [MIT License](LICENSE).
