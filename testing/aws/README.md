# Live AWS end-to-end validation

This harness deploys an isolated, short-lived Rat Things stack into the caller's AWS account,
validates it, and destroys it. It uses separate Terraform state and tags every resource with a
unique deployment ID.

## One command

```bash
AWS_E2E_ENABLE_MICROVM=true \
AWS_E2E_MICROVM_BASE_IMAGE_VERSION="<available pinned version>" \
npm run test:e2e:aws
```

The wrapper:

1. Packages the Lambda functions and MicroVM source bundle.
2. Applies the complete ephemeral Terraform stack and waits for the managed image.
3. Populates disposable GitHub, GitLab, Teams, and egress-capture secrets.
4. Reads public discovery, OpenAPI, and Thing schemas, then sends IAM-authenticated Thing, one-shot,
   and headless conversation requests plus real signed provider webhook requests. It also launches
   the local browser console through its real SigV4 loopback proxy and completes two continuous
   turns in one durable API conversation in Chromium against the deployed Lambda MicroVM backend.
5. Uses a disposable provider fixture to reject an invalid credential, derives two distinct account
   identities/authorizations, and verifies connection sets, provider/grant/Thing/profile permission
   intersection, immutable KMS-encrypted definitions, idempotent Thing execution, CLI rotation,
   revocation, and no secret leakage.
6. Enables an interval Thing and waits for EventBridge to submit the occurrence without an explicit
   run request, then verifies exactly one durable run with trusted schedule and Thing provenance.
7. Verifies MicroVM execution, pinned public-repository checkout, S3 output/events, DynamoDB state,
   EventBridge terminal events, Teams Adaptive Card egress, empty failure queues, and self-termination.
8. Sends two signed Teams activities and runs two messages through the actual Rat Things CLI,
   proves actual AWS suspension, authenticated continuation and resume on the same MicroVM ID,
   replay, provider egress where applicable, and re-suspension.
9. Backdates a suspended session to prove replacement, replay, and expired-VM termination, then
   injects the coordinator launch/attach crash window and proves idempotent repair.
10. Proves active-Run liveness fencing by observing a heartbeat without a semantic update, rejecting
   a stale generation, terminating the exact attached MicroVM, invoking the reconciler, and
   verifying a retryable `execution_lost` result.
11. Terminates any remaining MicroVMs, force-deletes runtime-created connection secrets, runs
   `terraform destroy` from an exit trap, and audits tagged residual resources.

The default stack uses the mock driver. It does not invoke Codex or Bedrock, so it spends no model
tokens. It creates no ECS/ECR resources. The S3 Files persistence leg does create a disposable VPC,
NAT gateway, VPC endpoints, and customer network connector; MicroVMs also retain AWS-managed public
egress. Every one of those resources is tagged and included in teardown auditing.

Set `AWS_E2E_REAL_CODEX=true` to add two bounded `openai.gpt-5.6-terra` probes through Bedrock. The
worker execution role mints a short-term token and the unprivileged Codex process receives only that
token. Set `AWS_E2E_DEFAULT_AGENT_DRIVER=codex` when a focused browser or API journey itself should
use Codex instead of the stack's default mock driver.
token. The persistence probe writes unique bytes through a command tool call, resumes the same
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

The deploy helper creates and DNS-validates a wildcard certificate in `us-east-1`, generates an
ephemeral CloudFront signing-key pair, stores only the private key in Secrets Manager, and removes
the local key files even if deployment fails. The base domain must be dedicated to untrusted agent
content and owned by the supplied public Route 53 zone. Terraform teardown removes the certificate,
validation record, wildcard aliases, distribution, key group, and signing-key secret.

Version `1` of the managed `al2023-1` base image was validated in `us-west-2` on 2026-08-03–04.
Managed Rat Things image versions `1.0` through `3.0` were created during integration debugging; the
final persistence run used `3.0`. Discover
availability again before relying on that value.

A fresh version `1` deployment passed all seven live workflows again on 2026-08-14. A focused
canary also launched the built `rat-things` executable twice against that stack and proved named
thread continuation on the same suspended MicroVM.

On 2026-08-21 deployment `th260821c` passed all seven applicable workflows (two opt-in cases were
skipped), including the revisioned multi-account Thing path. The harness terminated six MicroVMs,
removed runtime-created secrets, destroyed all 208 Terraform resources, and passed its tagged
post-destroy audit.

Later that day deployment `ev260821a` closed the remaining scheduled-Thing and real-provider
transport gaps. Ten applicable workflows passed with the real-Codex option enabled and only the
unconfigured custom-domain publication case skipped. EventBridge produced exactly one durable
scheduled Thing run without an API invocation; a real Codex agent then completed Slack `api.test`
and observed Slack's expected `invalid_auth` denial on the credentialed operation. Teardown
terminated seven MicroVMs, destroyed all 208 Terraform resources, passed the tagged-resource audit,
and left Terraform state empty.

On 2026-08-22 deployment `int260822a` passed all ten applicable workflows with the real-Codex option
enabled; only the unconfigured custom-domain publication case was skipped. The built CLI rejected an
invalid credential, connected two verified Fixture CRM accounts, and the real agent completed one
read on the read-only account plus one statically admitted write on the read/write account. The provider
audit queue contained exactly one mutation and neither credential appeared in durable run state,
output, or events. The full suite also repeated scheduled Thing, MicroVM continuation/replacement,
CLI continuity, crash repair, repository checkout, and real Codex workspace restoration. Teardown
then destroyed the 216-resource stack and audited tagged residuals.

A second fresh deployment, `int260822b`, reran the focused user journey after the final
credential-error and rotation changes. It passed in 22.78 seconds: the live API returned the exact
invalid-credential `400`, the built CLI onboarded both provider-derived accounts, permission
explanation selected the intended account, a real Lambda MicroVM completed the Thing, the CLI
rotated a credential-only file, and revocation removed access. Teardown destroyed all 216 resources,
left zero resources in Terraform state, and passed the direct post-destroy audit.

On 2026-08-24 deployment `perf260824a` ran the focused two-turn browser journey with the mock driver
and cold-start phase instrumentation. The first Run took 52.789 seconds from creation to the
runner's `startedAt`: 40.242 seconds mounted S3 Files and 4.178 seconds prepared the initial durable
state directories. The same suspended MicroVM then continued the conversation in 2.015 seconds,
with a 1 millisecond mount check and 108 milliseconds of state preparation. First-turn dispatcher
and coordinator queue delays were 585 and 830 milliseconds respectively; AWS accepted the cold
`RunMicrovm` request in 264 milliseconds, proving that request acceptance is not VM readiness.
Teardown terminated the one MicroVM, destroyed all 227 Terraform resources, and passed the tagged
post-destroy audit; only the disabled KMS key scheduled for deletion remains by AWS design.

Later on 2026-08-24 deployment `hb260824a` passed the focused generation-fenced liveness gate. A
live worker refreshed `heartbeatAt` without changing `updatedAt`; a stale generation was rejected;
the harness terminated the exact attached MicroVM; and the reconciler conditionally settled the Run
as retryable `execution_lost`. Teardown destroyed all 227 resources and passed the tagged-resource
audit. A subsequent full-suite run also exposed and fixed two dispatcher reliability defects: an
invalid generated DynamoDB attachment condition, and permanent classification of a transient AWS
control-plane HTML response that the SDK could not deserialize.

Fresh deployment `hb260824c` then passed all nine enabled live workflows with the patched bundle in
343 seconds; the three real-Codex/custom-domain opt-ins were intentionally skipped. The run repeated
signed provider concurrency, revisioned and scheduled Things, same-MicroVM Teams and CLI
continuation, expired-session replacement, coordinator crash repair, live heartbeat fencing and
forced termination, and repository checkout. The focused Chromium console journey also passed in
19.6 seconds with two IAM-authenticated turns on one durable MicroVM conversation. Teardown
terminated all seven test MicroVMs, destroyed all 227 Terraform resources, and passed the direct
tagged-resource audit; only the expected disabled KMS key pending deletion remained.

AWS does not allow immediate deletion of a customer-managed KMS key. Teardown disables the key and
schedules it for deletion after AWS's minimum waiting period; only that `PendingDeletion` key is an
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

Re-running `aws-e2e-deploy.sh` for an existing deployment inherits its saved OAuth map, webhook
toggle/signing-secret path, driver, and S3 Files settings. Explicit environment variables still
override saved values. This prevents a MicroVM-only update from silently removing the Slack route
or OAuth application configuration.

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

On 2026-08-27, deployment `oauth260827a` exercised the provider-agnostic part of this path and the
complete CLI management surface against 236 live AWS resources. The exact callback was discoverable,
invalid state failed closed with HTTP 400, and the unconfigured Slack app correctly reported
`host-required`. The same 21.8-second canary created, granted, rotated, and revoked a verified
Fixture CRM Connection, then created, listed, read, resumed, ran, paused, and deleted an interval
Routine; run-now completed in a real managed MicroVM with S3 Files enabled.

On 2026-08-28 PDT, that stack continued through a real Slack provider canary. An operator-owned
Slack app registered the exact live callback and Events URL, requested bot scopes
`app_mentions:read`, `chat:write`, and `reactions:write` plus delegated user scope `search:read`, and
enabled PKCE and token rotation. The built CLI waited through consent, token exchange, provider
identity verification, and Connection persistence. Slack returned separate rotating bot and user
token families; only the owner credential secret received those values. The desktop Connections
page changed Rat-side access and restored it, while the CLI independently observed the same active
Connection, four provider scopes, grant, one-Connection Set, and verified-workspace source binding.
Private frames exclude all credential screens and token values.

The same deployment exercised both channel ingress and authenticated agent tools. A human
`app_mention` passed Slack signature verification, started a real Codex conversation, and received
its result in the source thread. A follow-up reused the same conversation, MicroVM, and native Codex
thread and recalled a value from the first turn. Separately, the built CLI posted one uniquely
labeled root plus one threaded reply, added one check-mark reaction, proved persistent read-only
denial, and used `search:read` to recover the exact thread text and permalink. The live Connections
UI also round-tripped a second account's Rat grant while correctly showing that another Connection
owned mention routing.

Finally, the canary forced both `expires_at` and `user_expires_at` into the past. Fresh Runs
refreshed the bot and delegated-user token families independently; the stored credential again held
future expiries and both access/refresh pairs without printing any value. This found and fixed a
refresh parser that incorrectly required Slack to repeat `authed_user` while refreshing only the bot
token. MicroVM image `8.0` then passed the same-thread continuation after making ephemeral Codex
plugin-clone cleanup retrying and non-fatal.

That journey also found two failure-recovery defects before release. A first cold MicroVM timed out
mounting S3 Files and terminated. The completion worker tried to suspend it again and stranded the
conversation; terminated-session responses are now treated as already unavailable so failure is
folded durably and pending work wakes. The refresh canary then proved that the OAuth app ARN map was
missing from the MicroVM image even though IAM was already scoped correctly; Terraform now passes
only the ARN map into the image. Image `3.0` completed the refresh proof. One preceding image build
failed on an AWS Public ECR TLS handshake timeout and the identical non-destructive apply succeeded
on retry.

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
the synchronous persistent-storage portion of the run hook before considering prewarming or mount
deferral.

Terraform state and generated runtime configuration live under `.aws-e2e/<deployment-id>/` and are
ignored by Git. The runtime file contains disposable signing secrets and is permissioned while the
stack exists; teardown removes it. If a process is killed with `SIGKILL`, run the printed manual
destroy command immediately.
