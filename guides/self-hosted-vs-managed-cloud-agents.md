# Self-hosted versus managed cloud agents: how to choose

Choose a managed cloud-agent service when fast adoption, a maintained user experience, and minimal
platform work matter most. Choose a self-hosted agent backend when the cloud account, identity
boundary, credentials, network path, runtime policy, and durable data must remain under your
control—and your team is prepared to operate them. Neither choice is inherently safer; each moves
responsibility to a different place.

> **Short answer:** decide where trust and operations should live before comparing feature lists.
> The decisive question is usually “Who must be able to control or observe this agent?”

## Compare control planes, not landing pages

| Decision | Managed service | Self-hosted backend |
| --- | --- | --- |
| Control plane | Vendor-operated | Runs in your cloud account |
| Product UI | Usually included | You operate or build it |
| Identity and tenancy | Vendor model and integrations | Your principal-to-owner mapping |
| Agent credentials | Vendor vault and policy | Your vault, IAM, and broker |
| Runtime isolation | Vendor-defined and attested | Your selected compute boundary |
| Networking | Vendor egress and private-connect options | Your VPC, endpoints, proxies, and egress rules |
| Durable state | Vendor retention and export contract | Your database, object store, retention, and backups |
| Upgrades and incidents | Vendor responsibility | Your responsibility |
| Time to first value | Usually shorter | Usually longer |
| Custom embedding | Product-dependent | Full API and composition control |

Ask for evidence on each row. “Enterprise,” “private,” “isolated,” and “self-hosted” are not precise
enough without the actual trust boundary and failure behavior.

## Compare named options against the same questions

Start with real candidates, then verify their current documentation rather than projecting one
generic vendor onto every managed service:

- [Codex cloud](https://learn.chatgpt.com/docs/cloud) runs coding tasks in isolated cloud
  environments, supports parallel background work, and can start from GitHub, GitLab, Linear, or
  Slack.
- [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)
  works in a GitHub Actions-powered ephemeral environment and centers its workflow on repository
  research, branches, and pull requests.
- Rat Things is the self-hosted reference in this guide: an AWS control plane plus isolated Lambda
  MicroVM execution, durable conversations, schedules, and deployment-owned Connections.

This is not a feature ranking. Product behavior, plan availability, prices, and limits change. Use
each vendor's current documentation to fill the worksheet for your actual workflow.

## Choose managed when operations are not the product

A managed service is often the right answer when:

- the vendor's identity and data-handling model already meets policy;
- the available repositories, integrations, and permissions are sufficient;
- the team values a finished UI, onboarding, and support more than runtime control;
- workloads fit documented limits and regional availability; and
- the vendor can provide the required audit, retention, deletion, and incident evidence.

Do not recreate a platform merely to avoid a modest usage fee. Self-hosting adds deployment,
monitoring, upgrades, security patches, quotas, capacity, credential response, backups, and
failure-queue operations.

## Choose self-hosted when the boundary matters

A self-hosted backend becomes compelling when:

- agent execution must occur in a particular AWS account or network;
- the host must derive ownership from its existing product identity;
- OAuth applications and provider credentials must remain deployment-owned;
- IAM and egress must be enforceable independently of model instructions;
- conversations, files, and receipts need host-defined retention and deletion;
- the same backend must serve a CLI, product, schedule, provider event, and another agent; or
- integrations require reviewed, organization-specific operations rather than a general token.

Those benefits are meaningful only if the implementation actually preserves the boundary. A
“self-hosted” UI that calls a vendor control plane may have a different trust model from a fully
independent deployment.

## Place isolation around the untrusted work

Agent code may inspect repositories, run commands, browse the web, install dependencies, and invoke
connected services. Process or container isolation can be sufficient for trusted internal tasks,
but stronger tenant or repository boundaries may justify VM-level isolation.

Rat Things runs each active conversation in an AWS Lambda MicroVM. The outer MicroVM is the primary
execution boundary; an unprivileged agent process, sanitized environment, root-owned lifecycle
process, credential broker, browser URL policy, and IAM/network controls add layers inside and
outside it. Persistent conversation state lives outside the VM so compute can suspend or be
replaced.

This is an engineering design, not a blanket production claim. The project explicitly remains
unsuitable for untrusted multi-tenant production until its listed security gates are complete. Read
the [architecture](../docs/architecture.md#lambda-microvm-execution) and [production security
gates](../docs/security.md#production-security-gates).

## Decide how agents receive authority

Managed services usually offer a documented permission and approval model. Evaluate whether it
matches unattended workflows, provider-specific scopes, and your incident procedures.

Rat Things deliberately has no mid-Run approval inbox. Before launch, it intersects the deployment
profile, Run or Thing narrowing, IAM, network policy, provider scopes, persistent account grants,
operation rules, resource constraints, and installed tools. Inside that fixed envelope, work is
autonomous. Outside it, the capability is absent or denied.

This model is useful for schedules and headless systems because liveness does not depend on a human
approval channel. It also means every exposed action must be safe to exercise autonomously. If that
is not acceptable, use a managed product with the required approval semantics or split the workflow
into separate preparation and execution Runs.

## Compare durability beyond “task history”

Ask each option what survives:

1. Can the accepted request be recovered after the client disconnects?
2. Are full transcripts, tool events, and results durable?
3. Do generated files survive worker replacement?
4. Does the native model thread survive, or is only a summary replayed?
5. Can exact workspace bytes be restored?
6. How are ambiguous external writes reconciled?
7. What are the retention, export, and deletion guarantees?

Rat Things stores one Run receipt for every accepted execution, persists full bodies in encrypted
S3, and can restore native Codex and workspace state with S3 Files. The [durable-state
guide](durable-ai-agent-state.md) explains the layers and their failure cases.

## Include the full operating cost

A managed price contains some platform engineering, security, UI, support, and incident response.
A self-hosted bill usually does not. Compare:

- model usage and provider discounts;
- active and suspended compute;
- networking, storage, logs, keys, queues, and API resources;
- developer time for deployment and upgrades;
- security review and credential incident response;
- monitoring, backups, failure recovery, and on-call ownership; and
- the cost of missing product features your team must build.

Rat Things publishes a measured two-turn workload and its non-model infrastructure breakdown, with
explicit caveats. Use [the AWS agent cost guide](aws-ai-agent-cost.md) as a measurement template,
not as a universal price comparison.

## Evidence and limitations

| Evidence field | What is established |
| --- | --- |
| Date | September 7, 2026 |
| Source revision | Rat Things `c0156cd` plus the first-party product documentation linked below |
| Environment | Documentation review of Codex cloud, GitHub Copilot cloud agent, AWS Lambda MicroVMs, and the Rat Things implementation |
| Model/provider | Not applicable; this is a decision framework, not a model-quality benchmark |
| Scenario | Compare control location, identity, credential custody, networking, isolation, durability, operations, workflow fit, and total cost using one scoring method |
| Result | A complete weighted worksheet and mandatory-boundary rule; no universal product winner is asserted |
| Reproduce | Fill the worksheet with first-party evidence for the actual plans and workflow, reject mandatory failures, then run the highest-ranked candidate on one representative task |
| Evidence | [Rat Things validation ledger](../docs/status-and-roadmap.md) plus the named products' first-party documentation in [Sources](#sources) |
| Limits | This is **not** a controlled head-to-head benchmark, security attestation, price comparison, or claim that every managed or self-hosted system behaves alike. Validate plan-specific terms and run a representative proof before deciding. |

## A decision worksheet

For each requirement, assign a weight—`1` helpful, `2` important, or `3` mandatory—then score each
candidate from `0` (does not meet it) to `3` (fully meets it with acceptable evidence). Multiply
weight by score and record the source behind the score.

| Requirement | Weight 1–3 | Managed score 0–3 | Self-hosted score 0–3 | Evidence or constraint |
| --- | ---: | ---: | ---: | --- |
| Existing product identity and tenant mapping |  |  |  |  |
| Cloud-account and regional ownership |  |  |  |  |
| Credential custody and provider-specific grants |  |  |  |  |
| Network and data-residency constraints |  |  |  |  |
| Execution isolation |  |  |  |  |
| Durable conversation and workspace restoration |  |  |  |  |
| Finished UI and low-friction onboarding |  |  |  |  |
| Vendor support and operational offload |  |  |  |  |
| Custom integrations and API embedding |  |  |  |  |
| Team capacity to operate distributed infrastructure |  |  |  |  |

Reject any candidate that scores below `3` on a mandatory boundary, regardless of its total. For
the remaining options, compare `sum(weight × score)`, total operating cost, and the representative
workflow proof. Do not let a high UI score cancel a mandatory credential or residency failure.

If self-hosting wins, begin with one narrow, read-only workflow in a disposable AWS account. The
[Rat Things operating model](../docs/operating-model.md) and [quickstart](../docs/quickstart.md) show
that path without hiding the current limitations.

## Sources

- [OpenAI Codex cloud](https://learn.chatgpt.com/docs/cloud)
- [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)
- [AWS Lambda MicroVM lifecycle and pricing](https://aws.amazon.com/lambda/pricing/)
- [Rat Things architecture](../docs/architecture.md#lambda-microvm-execution)
- [Rat Things current maturity and validation ledger](../docs/status-and-roadmap.md)
