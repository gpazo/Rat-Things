# Lambda MicroVM image source

`npm run package` builds `dist/microvm-source.zip` with this directory plus the bundled
`runner.mjs`, Codex configuration, and Git askpass helper. AWS Lambda MicroVMs consumes that S3 ZIP,
runs the Dockerfile, starts the lifecycle server, and snapshots the initialized process tree.

The lifecycle server runs as root because the orchestration bundle needs the MicroVM execution-role
credentials for DynamoDB, S3, and Secrets Manager. It launches `runner.mjs` as root; the runner is
responsible for resolving any configured credential secret and dropping the Codex subprocess to
UID/GID 10001 with a sanitized environment. Never change the image entrypoint
to the `agent` user: doing so breaks AWS orchestration, while passing the root credential environment
to the model-driven subprocess defeats the isolation boundary.

The `/run` hook accepts the service wrapper `{ microvmId, runHookPayload }`. The nested payload is
versioned and contains only run IDs, S3/DynamoDB references, bounded configuration, and (optionally)
a Secrets Manager ARN. Prompts and provider tokens are never hook payload fields. A run reads its
input from encrypted S3 after the MicroVM receives fresh run-time credentials.

After a one-shot `runner.mjs` exits, the root lifecycle server launches the separately bundled
`terminate-microvm.mjs`. Conversation runs instead keep the server, workspace, and Codex session
files alive. The coordinator suspends the VM after each slice and submits later slices through the
authenticated `/agent-runtime/v1/runs` endpoint after calling `ResumeMicrovm`. AWS preserves memory
and disk while suspended. DynamoDB and S3 remain authoritative because a MicroVM is terminated no
later than eight hours after launch.

Lifecycle endpoints listen on port 8080 under
`/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`. Terraform enables all
six hooks. Individual MicroVMs are launched by the dispatcher API and are never modeled as
long-lived Terraform resources. Batch runs self-terminate; conversation sessions use the configured
idle policy and explicit suspend/resume calls.
