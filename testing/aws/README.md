# Live AWS end-to-end validation

This harness deploys an isolated, short-lived Rat Things stack into the caller's AWS account,
validates it, and destroys it. It uses separate Terraform state and tags every resource with a
unique deployment ID.

## One command

```bash
npm run test:e2e:aws
```

The wrapper:

1. Packages the Lambda functions and MicroVM source bundle.
2. Applies the complete ephemeral Terraform stack and waits for the managed image.
3. Populates disposable GitHub, GitLab, Teams, and egress-capture secrets.
4. Reads public discovery, OpenAPI, and Thing schemas, then sends IAM-authenticated Thing, one-shot,
   and headless conversation requests plus real signed provider webhook requests. With
   `AWS_E2E_DEFAULT_AGENT_DRIVER=codex`, it also launches the local browser console through its real
   SigV4 loopback proxy and completes two continuous turns in one durable API conversation in
   Chromium against the deployed Lambda MicroVM backend.
5. Uses a disposable provider fixture to reject an invalid credential, derives two distinct account
   identities/authorizations, and verifies connection sets, provider/grant/Thing/profile permission
   intersection, immutable KMS-encrypted definitions, idempotent Thing execution, CLI rotation,
   revocation, and no secret leakage.
6. Enables an interval Thing and waits for EventBridge to submit the occurrence without an explicit
   run request, then verifies exactly one durable run with trusted schedule and Thing provenance.
7. Verifies MicroVM execution, pinned public-repository checkout, S3 output/events, DynamoDB state,
   EventBridge terminal events, source-routed Teams Adaptive Card egress, empty failure queues, and
   self-termination. GitHub and GitLab ingress is tested without external notification credentials;
   their delivery fences must record `not_delivered` and identify the missing setting. Teams
   delivery is verified through the disposable capture endpoint.
8. Sends two signed Teams activities and runs two messages through the actual Rat Things CLI,
   proves actual AWS suspension, authenticated continuation and resume on the same MicroVM ID,
   replay, provider egress where applicable, and re-suspension.
9. Backdates a suspended session to prove replacement, replay, and expired-VM termination, then
   injects the coordinator launch/attach crash window and proves idempotent repair.
10. Proves active-Run liveness fencing by observing a heartbeat without a semantic update, safely
   deferring one uncertain control-plane observation, rejecting a stale generation, terminating the
   exact attached MicroVM, invoking the reconciler, and verifying a retryable `execution_lost`
   result.
11. Terminates any remaining MicroVMs, force-deletes runtime-created connection secrets, runs
   `terraform destroy` from an exit trap, and audits tagged residual resources.

The default stack uses the mock driver. It does not invoke Codex or Bedrock, so it spends no model
tokens, and the wrapper skips the agent-semantic browser journey. The local console suite covers the
deterministic UI path; the live console journey requires `AWS_E2E_DEFAULT_AGENT_DRIVER=codex`
because it validates that an agent reads an uploaded file and creates a new artifact. The stack
creates no ECS/ECR resources. The S3 Files persistence leg does create a disposable VPC, NAT
gateway, VPC endpoints, and customer network connector; MicroVMs also retain AWS-managed public
egress. Every one of those resources is tagged and included in teardown auditing.

The live harness uses the AWS SDK's standard retry mode with five total attempts. This leaves
transient service and network recovery to the SDK instead of duplicating retry policy in test or
application code.

Each completed workflow prints its name and result. The pinned Terraform AWS provider owns both
public-invocation permissions for the disposable fixture's unauthenticated Lambda Function URL;
adding separate permission resources can race its policy updates during deployment.

Set `AWS_E2E_REAL_CODEX=true` to add bounded `openai.gpt-5.6-terra` probes through Bedrock. The
worker execution role mints a short-term token and the unprivileged Codex process receives only that
token. Set `AWS_E2E_DEFAULT_AGENT_DRIVER=codex` when a focused browser or API journey itself should
use Codex instead of the stack's default mock driver.
The persistence probe writes unique bytes through a command tool call, resumes the same
MicroVM and Codex thread, and reads those bytes from the same workspace path. The integration probe
connects two separately credentialed Fixture CRM accounts through the built CLI, gives one verified
read scope and the other verified read/write scopes, and asks the real agent to search the first and
create through the second. The harness verifies one provider-side audit message and scans run
state/output/events for both credential values. Together the probes verify autonomous dynamic tools,
fixed-envelope exact-account selection, workspace patches, usage, state,
re-suspension, no credential leakage, and empty failure queues.

Set both publication variables to add the isolated CloudFront delivery path to the disposable stack:

```bash
AWS_E2E_PUBLICATION_DOMAIN="agent-content.example.com" \
AWS_E2E_PUBLICATION_ROUTE53_ZONE_ID="Z1234567890" \
./scripts/aws-e2e-deploy.sh demo
```

The deploy helper verifies the zone's public DNS delegation before allocating resources, then
creates and DNS-validates a wildcard certificate in `us-east-1`, generates an
ephemeral CloudFront signing-key pair, stores only the private key in Secrets Manager, and removes
the local key files even if deployment fails. The base domain must be dedicated to untrusted agent
content and owned by the supplied public Route 53 zone. Terraform teardown removes the certificate,
validation record, wildcard aliases, distribution, key group, and signing-key secret.

The harness pins managed `al2023-1` base image version `1` by default. Set
`AWS_E2E_MICROVM_BASE_IMAGE_VERSION` to use another available version.

AWS does not allow immediate deletion of a customer-managed KMS key. Teardown disables the key and
schedules it for deletion after the configured waiting period; only that `PendingDeletion` key is an
expected residual resource. All other Terraform-managed resources are destroyed and directly
audited.

LocalStack validates the shared data/event workflow but does not implement the Lambda MicroVM
control plane, image lifecycle, hooks, managed connectors, or isolation. This leg is therefore a
live-AWS-only test.

## Manual phases

```bash
./scripts/aws-e2e-deploy.sh
./scripts/aws-e2e-test.sh
./scripts/aws-e2e-console-test.sh
./scripts/aws-e2e-console-demo.sh # optional H.264 recording of the focused browser journey
./scripts/aws-e2e-destroy.sh
```

The ordinary suite proves the CLI, connection vault, grants, rotation, revocation, and routine
lifecycle against live AWS with a disposable provider fixture. A real OAuth provider is an explicit
operator-owned opt-in. Supply only an existing Secrets Manager ARN at deployment time:

```bash
AWS_E2E_OAUTH_APP_SECRET_ARNS='{"slack":"arn:aws:secretsmanager:us-west-2:111122223333:secret:rat/oauth/slack-AbCdEf"}' \
AWS_E2E_ENABLE_SLACK_WEBHOOK=true \
AWS_E2E_SLACK_SIGNING_SECRET_FILE=/secure/path/slack-signing-secret \
AWS_E2E_REAL_CODEX=true \
AWS_E2E_DEFAULT_AGENT_DRIVER=codex \
./scripts/aws-e2e-deploy.sh oauth-canary

npm run aws:e2e:oauth:test -- oauth-canary slack
```

The secret JSON must contain `client_id` and `client_secret`, and the Slack app must register the
deployment's `oauth_callback_url` and Slack webhook URL. Subscribe to `app_mention`; request bot
scopes `app_mentions:read`, `chat:write`, and `reactions:write` plus user scope `search:read`, then
reinstall after changing scopes. The canary opens the reviewed authorization URL, waits for the
callback, and prints only the verified public Connection bundle. It never copies the app secret,
signing secret, or issued tokens into the runtime environment, command line, Terraform state, or
test log. Use a disposable provider app/workspace and destroy the stack afterward.

Deploy and destroy reuse the stack’s saved AWS region, MicroVM, publication, OAuth, and webhook
settings. Explicit environment variables override saved values, so repeat deployments and teardown
do not require repeating the original options. Settings are saved after a successful apply; if the
initial apply fails before `runtime.env` exists, reuse the original options for retry or teardown.

After consent creates the verified Connection and the bot joins a disposable channel, opt into the
external CLI action/denial case with public identifiers only:

```bash
AWS_E2E_REAL_SLACK=true \
AWS_E2E_SLACK_CONNECTION_ALIAS=slack-disposable \
AWS_E2E_SLACK_CHANNEL_ID=C0123456789 \
./scripts/aws-e2e-test.sh oauth-canary
```

This paid real-Codex case temporarily raises the Rat grant, posts one uniquely labeled root and one
thread reply, adds one reaction, narrows access and proves the post tool is unavailable, then uses
the separately authorized Slack user token to find the exact thread reply and permalink. Cleanup
restores the Connection's original grant even when an assertion fails. It never changes provider
scopes or exposes either OAuth token family. Independently confirm the labeled message, reply,
reaction, and absent denied marker in the Slack client.

For Linear, install a private OAuth app and Connection first, then run the opt-in real-provider
case against a disposable team:

```bash
AWS_E2E_REAL_LINEAR=true \
AWS_E2E_LINEAR_CONNECTION_ALIAS=linear-work \
AWS_E2E_LINEAR_TEAM_KEY=IND \
./scripts/aws-e2e-test.sh oauth-canary
```

The write Run discovers the team, creates one uniquely labeled issue, updates it, comments, and
reads it back. The durable ledger must contain exactly those five successful operations. A fresh
read-only Run then searches and gets the same issue while proving create was not exposed. For a
shareable console recording of a completed proof, run `npm run aws:e2e:linear:demo -- DEPLOYMENT_ID`.

Install the browser used by the focused console phase once per machine:

```bash
npm run test:e2e:console:install
```

The deploy command stores the generated deployment ID in `.aws-e2e/latest`. Pass it explicitly when
multiple runs exist:

```bash
npm run aws:e2e:status
cat .aws-e2e/latest
AWS_PROFILE=YOUR_PROFILE ./scripts/aws-e2e-console-test.sh e2e-260802120000
./scripts/aws-e2e-destroy.sh e2e-260802120000
```

The focused console command reuses an existing stack; it must run under the same AWS credential
context used for deployment and does not assume permission to deploy or destroy. It creates one
durable API conversation and two Runs, proves the second turn resumed the same MicroVM, and may
leave the corresponding MicroVM suspended until normal
lifecycle cleanup or stack teardown. Playwright failure artifacts can contain prompts and
transcripts, are created with private permissions under ignored `test-results/`, and should use
disposable content. Destroy clears `.aws-e2e/latest` only when the pointer still names that stack.
`npm run aws:e2e:status` is a read-only inventory of local deployment records; `ready-local` means
state and runtime files exist, not that AWS has independently confirmed every resource. Focused
tests refuse older runtime records that lack the pinned deployment account and principal.

For cold-start analysis, compare the dispatcher CloudWatch EMF metrics `QueueDelay`,
`ProcessingDuration`, `MicrovmLaunchRequestDuration`, and `MicrovmResumeRequestDuration`. The
request-duration names are intentional: AWS can accept a cold `RunMicrovm` request before the new
VM has booted and completed its run hook. A resume that has to replace an expired or unavailable
session also emits `MicrovmResumeFallback`; launch/resume errors emit `MicrovmStartupFailure`. The
MicroVM log entry `agent runner started` reports
`startupDurationMs`, `storageMountDurationMs`, `storagePreparationDurationMs`, and whether storage
was already mounted. These fields contain durations and infrastructure state only—not prompts,
transcripts, owner IDs, or credentials. Together they distinguish queueing, AWS launch/resume, and
the synchronous persistent-storage portion of the run hook. These host measurements exclude Codex
initialization; diagnose that phase separately using the
[startup guidance](../../docs/runbook.md#slow-conversation-startup-or-codex-initialization).

Terraform state and generated runtime configuration live under `.aws-e2e/<deployment-id>/` and are
ignored by Git. The runtime file contains disposable signing secrets and is permissioned while the
stack exists; teardown removes it. If a process is killed with `SIGKILL`, run the printed manual
destroy command immediately.
