# Ten-minute AWS quickstart

This is the shortest honest path from a fresh clone to one independently operated Rat Things
deployment and one real, active Thing. The default invokes Codex through Amazon Bedrock inside an
AWS Lambda MicroVM. It does not substitute a mock response for an agent response.

The stopwatch starts after the prerequisites below are installed and AWS credentials are active.
The command records its own start, finish, elapsed seconds, Thing ID, test Run ID, and output preview
in `.runtime/aws-quickstart/result.json`. It fails the golden-path gate if the successful journey
takes more than ten minutes. The terminal shows four useful stages while complete package and
Terraform output goes to `.runtime/aws-quickstart/quickstart.log`.

## Prerequisites

- Node.js 20 or newer, npm, Git, Terraform 1.5 or newer, and the AWS CLI.
- AWS credentials with authority to create the resources in `infra/`.
- A supported Region: `ap-northeast-1`, `eu-west-1`, `us-east-1`, `us-east-2`, or `us-west-2`.
- Lambda MicroVM access and quota in that Region.
- Amazon Bedrock access to the selected Codex model. Model tokens are billed by AWS.

Check the exact proposed configuration without changing AWS:

```bash
npm run quickstart:aws -- --dry-run
```

## Run it

```bash
git clone https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm ci
npm run quickstart:aws
```

The setup pauses once to show the exact AWS account, Region, MicroVM base image, driver, model-cost
boundary, state path, and deliberately omitted features. After confirmation it:

1. discovers and pins the newest available `al2023-1` Lambda MicroVM base-image version;
2. packages Rat Things and applies the minimal backend needed for this first manual Thing, with no VPC/NAT, OAuth account,
   schedule, or public-sharing distribution;
3. runs `rat-things doctor` against the installed discovery and authenticated API;
4. creates a read-only, no-network manual Thing;
5. explains it, tests the exact immutable draft in a real MicroVM, waits for success, and verifies a
   unique marker in the agent output; and
6. publishes only the revision and `specHash` proven by that successful test Run.

The terminal result is machine-readable evidence. Success requires all of these fields:

```json
{
  "status": "ready",
  "driver": "codex",
  "thingId": "...",
  "testRunId": "...",
  "outputPreview": "...RAT-THINGS-READY-...",
  "elapsedSeconds": 0,
  "underTenMinutes": true
}
```

## Latest measured proof

On August 23, 2026, the exact command above created a fresh 158-resource disposable stack in
`us-west-2`, invoked real Codex through `openai.gpt-5.6-terra`, verified the unique output marker,
and activated the exact tested Thing revision in **413 seconds (6m53s)**. A follow-up live canary
then submitted two prompts through one named thread and proved that each prompt received one Run,
the second Run executed the coordinator-prepared replay transcript, and the suspended MicroVM
resumed successfully.

Teardown terminated the remaining MicroVM and destroyed all 158 Terraform resources. Independent
checks found empty Terraform state and no quickstart MicroVMs; only the disabled KMS key remains in
AWS's mandatory `PendingDeletion` state. This is proof of the narrow path, not a load, quota,
multi-tenant, or disaster-recovery claim.

Use a named AWS profile or Region without editing Terraform:

```bash
npm run quickstart:aws -- --profile personal --region us-west-2
```

For a token-free infrastructure diagnostic, choose the mock explicitly:

```bash
npm run quickstart:aws -- --driver mock
```

That mode proves deployment, IAM-authenticated discovery, the complete Thing lifecycle, durable
state, queueing, MicroVM launch, artifacts, and exact tested-revision publication. It is not a model
or agent-behavior proof, and the command labels it that way before making changes.

## Inspect and remove it

The quickstart is deliberately disposable. Its state and non-secret evidence stay under
`.runtime/aws-quickstart/`; it does not touch a normal `infra/terraform.tfstate` or require a remote
state backend. The full debug log is local, ignored by Git, and intended to make a failed stage
inspectable without filling the normal terminal path with thousands of Terraform lines.

```bash
npm run quickstart:aws -- status
npm run quickstart:aws -- destroy
```

`status` reruns deployment diagnostics and reads the exact Thing. `destroy` confirms the target,
terminates any remaining MicroVM for this image, destroys only the quickstart state, and retains the
local result record as evidence. AWS schedules the customer-managed KMS key for deletion because it
does not permit immediate key deletion.

Do not use this disposable state layout as an unreviewed shared production deployment. Once the
narrow journey is delightful and stable, choose retention, state backend, identity boundary,
durable conversations, integrations, schedules, and publication delivery deliberately in the
[deployment guide](development-and-deployment.md).

## If it stops

- `required command not found` or `... is required`: install the named prerequisite and rerun.
- `could not discover a Lambda MicroVM base image`: confirm Region/service access, or pass a known
  available version with `--microvm-base-image-version`.
- Terraform `AccessDenied`: the active principal cannot create one of the printed resources. Do not
  broaden agent permissions; fix the host deployment role.
- A failed Codex test with a Bedrock error: confirm model access in the selected Region, or rerun
  with another `--model`. Use `--driver mock` only when the goal is infrastructure diagnosis.
- A failed Thing explanation or test prints the created Thing ID before stopping. Inspect it with
  `rat-things thing THING_ID`, then use [diagnostics](diagnostics.md).
- An interrupted setup may leave exact resources in the quickstart state. Run
  `npm run quickstart:aws -- destroy`; do not delete the state file first.

The quickstart intentionally proves one small product path. Continue with [Things](things.md), then
add [accounts and permissions](plugins.md) or the [deeper agent controls](agents.md) only when the
task needs them.
