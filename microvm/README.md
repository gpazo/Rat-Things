# Lambda MicroVM image source

`npm run package` builds `dist/microvm-source.zip` with this directory plus the bundled
`runner.mjs`, Codex configuration, and Git askpass helper. AWS Lambda MicroVMs consumes that S3 ZIP,
runs the Dockerfile, starts the lifecycle server, and snapshots the initialized process tree.

The lifecycle server runs as root because the orchestration bundle needs the MicroVM execution-role
credentials for DynamoDB, S3, and Secrets Manager. It launches `runner.mjs` as root; the runner is
responsible for resolving any configured credential secret and dropping only the actual Codex or
Claude subprocess to UID/GID 10001 with a sanitized environment. Never change the image entrypoint
to the `agent` user: doing so breaks AWS orchestration, while passing the root credential environment
to the model-driven subprocess defeats the isolation boundary.

The `/run` hook accepts the service wrapper `{ microvmId, runHookPayload }`. The nested payload is
versioned and contains only run IDs, S3/DynamoDB references, bounded configuration, and (optionally)
a Secrets Manager ARN. Prompts and provider tokens are never hook payload fields. A run reads its
input from encrypted S3 after the MicroVM receives fresh run-time credentials.

After `runner.mjs` exits, the root lifecycle server launches the separately bundled
`terminate-microvm.mjs`. That helper calls `TerminateMicrovm` using the execution role so completed
batch runs do not linger until their maximum duration. It is a separate process so the lifecycle
server can answer the resulting `/terminate` hook without deadlocking the API call.

Lifecycle endpoints listen on port 8080 under
`/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`. Terraform enables all
six hooks. Individual MicroVMs are intentionally launched and terminated by the dispatcher API, not
modeled as long-lived Terraform resources.
