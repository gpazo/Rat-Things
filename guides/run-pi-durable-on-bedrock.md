# How to run Pi Durable on Amazon Bedrock

Configure Pi Durable in a Rat Things deployment, discover its approved models,
and create a durable Session. The API, CLI, and desktop console use the same
Session and saved history for Codex and Pi Durable.

## Configure the deployment

Use an installed Rat Things AWS backend with the pinned Pi runtime. In the
Terraform configuration, set exact model IDs and inference resource ARNs:

```hcl
pi_bedrock_model_ids     = ["amazon.nova-micro-v1:0"]
pi_bedrock_default_model = "amazon.nova-micro-v1:0"
pi_bedrock_inference_resource_arns = [
  "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-micro-v1:0",
]
```

Use IDs supported by the pinned Pi catalog and available to your AWS account.
Match the ARN region to your deployment. For cross-region inference profiles,
include the profile ARN and each required destination model ARN. Follow the
[Pi inference configuration](../infra/README.md#enable-pi-inference) for grants and
deployment commands. Applying the configuration provisions or changes AWS resources.

An empty Pi model list disables the runtime. Pi uses Bedrock independently of
`codex_auth_mode`. A ChatGPT login is not required for Pi inference. The automated
`quickstart:aws` helper currently creates Codex Sessions; use the Terraform path
to configure Pi.

If the agent needs commands or workspace files, also enable S3 Files and
`session_checkpoints_enabled`. For this first Session, use environment `none`,
which is the CLI default.

## Discover the approved models

Build the CLI and set your deployment endpoint and region:

```bash
npm ci
npm run build
export RAT_THINGS_AGENTS_API_URL="https://your-agents-endpoint/v1"
export AWS_REGION="us-west-2"
npm run rat-things -- agents models --runtime pi
```

The command lists the deployment's admitted Pi models and their supported settings.
Your workstation's AWS identity must be allowed to invoke the deployment's token
issuer. Model inference uses the deployment's Bedrock permissions.

## Start and continue a Session

Choose an ID from that catalog:

```bash
npm run rat-things -- sessions create --runtime pi \
  --model amazon.nova-micro-v1:0 \
  --input "Help me plan a repository review." --stream
```

Save the returned Session ID, then inspect and continue it:

```bash
npm run rat-things -- sessions runtime sess_example
npm run rat-things -- sessions send sess_example --input "Include the test strategy."
npm run rat-things -- sessions turns sess_example
npm run rat-things -- sessions items sess_example
```

The runtime readback reports `pi`, its engine version, and the selected model.
Saved Turns and Items remain available after the client disconnects. The Session
keeps its runtime choice; create another Session to switch to Codex.

## Reuse the Agent in other workflows

Put `metadata: { "rat_things_runtime": "pi" }` on a saved Agent request. Sessions
created from that Agent inherit Pi unless they explicitly select another runtime.
Schedules and provider bindings can reference the same saved Agent.

In the desktop console, choose **Pi** in **Runtime**, then select a model.
For SDK requests, use the [runtime selection example](../docs/agents-api.md#choose-a-session-runtime).
Standalone `local --driver pi` is not supported.

## Current boundaries

Pi supports explicit function tools, MCP, and subagents. Hosted skills and plugins,
self-hosted environments, JSON-schema output, and built-in web search are currently
unsupported. Check the [runtime comparison](../docs/agent-runtimes.md) before moving
an existing Codex Agent to Pi.

Model availability depends on the deployment catalog, AWS account access, and region.
Saved native state supports worker recovery; it does not restore running processes
or guarantee that an interrupted external write can be repeated safely.

## Sources

- [Rat Things runtime contract](../docs/agents-api.md#choose-a-session-runtime)
- [Pi Bedrock deployment configuration](../infra/README.md#enable-pi-inference)
- [Pi Durable's task and storage design](https://earendil.com/posts/pi-durable/)
