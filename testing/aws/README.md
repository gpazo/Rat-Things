# Live AWS validation

The harness deploys an isolated stack into the caller's AWS account, invokes a
configured model through the Agents API, and tears the stack down. Ordinary
`npm run check` skips it. MicroVM provisioning and model calls require explicit
opt-in:

```bash
AWS_E2E_REAL_CODEX=true AWS_E2E_CODEX_MODEL_ID=YOUR_ADMITTED_MODEL npm run test:e2e:aws
```

The model must be admitted by the stack's configured Bedrock credentials and
region. The wrapper packages Lambda artifacts, deploys the ARM64 MicroVM image,
runs the API and console canaries, terminates remaining MicroVMs and destroys the
isolated stack from its exit trap. Deployment identity and Terraform state live
under `.aws-e2e/DEPLOYMENT_ID/`; recovery verifies the original AWS account.

## Shared Sessions and local Share

Set `AWS_E2E_SHARED_SESSIONS=true` when deploying to add an isolated Cognito user
pool, public PKCE client and application-authenticated streaming API. Test users
are created without notifications and removed by the proof controller; their
passwords and SDK tokens stay in memory. The normal stack destroy removes the
identity provider too.

```sh
AWS_E2E_SHARED_SESSIONS=true AWS_E2E_REAL_CODEX=true \
  AWS_E2E_CODEX_MODEL_ID=YOUR_ADMITTED_MODEL npm run aws:e2e:deploy -- DEPLOYMENT_ID
set -a
source .aws-e2e/DEPLOYMENT_ID/runtime.env
set +a
npx vitest run tests/aws/shared-sessions.test.ts --no-file-parallelism
```

The test uses Cognito-issued access JWTs for distinct manager, collaborator,
viewer and outsider identities. It checks concurrent inputs with the same
client key, two activity subscriptions, disconnected completion, replay,
revocation and ID-token rejection. SDK password authentication tests API token
verification; it does not establish browser login behavior.

For browser login and local execution handoff, first run
[installed subscription acceptance](../local-runtime/README.md#installed-live-subscription-acceptance)
with a model supported by both providers, then use its evidence with the same
app and private profile:

```sh
RAT_INSTALLED_SHARE_ACCEPTANCE=1 node --import tsx testing/local-runtime/installed-share.ts \
  --app "/path/to/Rat Things.app" --directory "$HOME/rat-private-subscription" \
  --evidence "$HOME/rat-private-subscription/installed-subscription-acceptance-RANDOM/evidence.json"
```

The controller signs a disposable collaborator in through the real Cognito
browser flow and host PKCE helper, uses the installed local service's ordinary
Share route, then requires the same Session/Agent, exact completed history and
successful hosted command output verifying the source workspace hashes. It
restarts the local service and confirms further local input and abort are denied
after release. Hosted continuation runs with the local service stopped. The
controller removes its saved login and test users; retained cloud resources are
removed by deployment teardown. The source profile and evidence are retained.

To validate the current source host with a native development guest, use a separate
private profile signed in through the source CLI. Supply the current host Codex
executable, the explicit native-proof asset directory, and a model supported by
both providers. Source the same deployment's `runtime.env` first.

```sh
CODEX_BINARY=/absolute/path/to/current/codex \
RAT_DEVELOPMENT_SHARE_ACCEPTANCE=1 AWS_E2E_REAL_CODEX=true \
  node --import tsx testing/local-runtime/development-share.ts \
  --directory /absolute/private/source-profile \
  --assets /absolute/path/to/native-proof-assets --model YOUR_SHARED_MODEL
```

This controller refuses profiles containing installed runtime storage or an
existing service connection. It uses the current public local HTTP service and
integrity-checked development assets. It requires two successful subscription
Turns with a service restart, workspace hashes, setup-once behavior, and guest
isolation before the same browser login and Share checks. The hosted continuation
must also recall a random marker supplied only in the earlier local conversation,
without the marker in its new prompt or workspace commands. Evidence records the
host version and guest manifest identity. Cached development assets may predate
the current source. A pass proves command compatibility for those named assets;
it does not establish signed distribution or current packaged guest acceptance.
The controller retains the source profile, workspace, and private evidence.

This live controller exercises normal handoff and completed retry. Deterministic
Share tests separately inject lost acknowledgements, delayed staging, retirement
and activation races. Browser login here exercises the host helper, while native
control interactions have their own desktop tests.

```sh
npm run aws:e2e:destroy -- DEPLOYMENT_ID
```

## Other live canaries

To configure the optional Pi proof, set `AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON` and
`AWS_E2E_PI_BEDROCK_INFERENCE_RESOURCE_ARNS_JSON` to JSON arrays. The module
checks the model IDs and exact inference resource ARNs before it grants access.
Set `AWS_E2E_REAL_CODEX=true` and `AWS_E2E_ENABLE_MICROVM=true` when you deploy.
After the deployment, source its `runtime.env` and run:

```bash
AWS_E2E_PI_PROOF=true npx vitest run tests/aws/pi-runtime.test.ts
```

The proof runs each configured model in sequence. It creates and deletes its
own Agent and Session for each model. It verifies a function result, a stopped
MicroVM, committed native history, and a replacement worker that recalls the
result. The proof requires at least two distinct configured model IDs.

The API canary uploads and downloads a binary File, checks deletion and rejected
unauthenticated access, then creates an Agent and verifies two completed root
Turns using saved assistant Items. It deletes the disposable Session and Agent.
The console canary creates and continues a Session, reloads saved output and
closes the Session. These are bounded smoke tests, not full deployment conformance.

The managed Session canary checks streamed completion events, input idempotency,
actual command execution, UID 10001, control-port denial, immutable saved artifacts
and continuation of the same command process across two Turns. On EC2 it also
requires IMDS and host-configuration access to be denied. Optional
`AWS_E2E_SOAK_SECONDS=28860` keeps the Session idle beyond eight hours before the
second Turn. This requires `AWS_E2E_ENABLE_EC2_WORKER=true` and
`AWS_E2E_LONG_RUNNING_AGENT_ID` selecting a saved Agent already listed with its owner in
`AWS_E2E_EC2_SESSION_WORKLOADS_JSON` at deployment. The supplied Agent is retained after
the test; the Session is deleted. The same Agent selection is forwarded by the observer
launcher. Keep MicroVM enabled for ordinary tests; EC2 availability alone no longer routes
Sessions to it. The ordinary invocation does not wait eight hours.

With both backends enabled and that saved Agent configured, set
`AWS_E2E_BACKEND_PLACEMENT=true` to run the placement proof. It checks the private
Run execution for an ordinary Agent and the allowlisted Agent, confirms EC2 uses
the selected AMI, and verifies that metadata edits do not move either Session.
The proof requires operator read access to the disposable Run table and EC2;
it is not part of the limited-role observer.

`tests/aws/session-recovery.test.ts` cancels a native Turn waiting for a function
result, reconnects the event stream before reading saved state, and checks that
a follow-up Turn completes. Its worker-loss case requires the additional
`AWS_E2E_WORKER_RECOVERY=true` and `AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID` inputs.
These dedicated-worker fault probes also require `AWS_E2E_LONG_RUNNING_AGENT_ID`
selecting an allowlisted Agent; they retain that supplied Agent after cleanup.
It verifies the deployment account, Run, generation and immutable launch-template
tag before terminating the exact EC2 instance created by that fixture. It then
waits for reconciliation. The replacement harness must retain context. For hosted environments, it must reset
the workspace, preserve the environment ID, emit one reset event and retain previously
captured artifacts. A separate case points the disposable Session at an absent native
thread after worker termination and verifies fallback to saved public history. This
tests ordinary replacement, not adoption of a committed workspace checkpoint. The
cases delete their own Sessions and preserve the supplied Agent and deployment.

Package and verify the official Linux ARM64 artifact before packaging (see
`testing/README.md`). EC2 deployment additionally requires an immutable
`AWS_E2E_EC2_WORKER_AMI_ID` and digest-pinned `AWS_E2E_EC2_WORKER_IMAGE`.
To exercise prepared AMIs, deploy with `AWS_E2E_ENABLE_EC2_WORKER_AMI_PIPELINE=true`
and `AWS_E2E_EC2_WORKER_AMI_BASE_ID` set to the pinned ARM64 parent image. Component
and recipe versions use `AWS_E2E_EC2_WORKER_AMI_COMPONENT_VERSION` and
`AWS_E2E_EC2_WORKER_AMI_RECIPE_VERSION` (both default to `1.0.0`). The `ec2_worker`
Terraform output exposes the pipeline ARN. Start its build explicitly as described
in the [infrastructure guide](../../infra/README.md#prepare-an-ec2-worker-ami), then
redeploy with `AWS_E2E_EC2_WORKER_PREPARED_AMI=true` and the returned image ID in
`AWS_E2E_EC2_WORKER_AMI_ID`. These settings persist across harness redeploys.
Delete build-produced AMIs and their snapshots after terminating the test workers;
Terraform removes the pipeline but does not own its generated images.

The deployment always exposes the Agents API through a Lambda Web Function. The
HTTP transport canary round-trips an 8 MiB File with an end-to-end checksum and
requires no model call. Set `AWS_E2E_LARGE_FILE_MIB=512` for a bounded maximum-size
upload check. The configured `RAT_THINGS_AGENTS_API_URL` must be the regional
Web Function endpoint exported by Terraform.

Current execution proofs use canonical Sessions. The [harness guide](../README.md)
lists focused opt-ins for recovery, schedules, credentials, tool permissions,
checkpoints and forks; a default smoke run does not execute every proof.

For configuration and MCP authorization history, set
`AWS_E2E_AUTHORITY_AUDIT_PROOF=true` and run
`tests/aws/authority-audit.test.ts` against a disposable real-Codex deployment.
The proof calls the deployment-owned MCP fixture, rotates and revokes a synthetic
credential, checks the retained configuration references, and exports every
authorization page as OTLP. The worker must have HTTPS egress to the fixture.
The test removes its Sessions, Agent and Vault; destroy the stack afterward to
remove its retained audit history and infrastructure.

The four-feature proof additionally requires `AWS_E2E_SUPER_AGENT_PROOF=true`,
`AWS_E2E_ENABLE_SLACK_WEBHOOK=true`, and `AWS_E2E_SLACK_SIGNING_SECRET_FILE` pointing
to a private signing-secret file at deployment. Set `AWS_E2E_EVENT_FILTER_MODEL_ID`
to a structured-output Converse model and
`AWS_E2E_EVENT_FILTER_INFERENCE_RESOURCE_ARNS_JSON` to its exact profile and model
ARNs. This opt-in enables a one-minute watchdog schedule, candidate message intake,
and deployment-owned Teams delivery capture. Source the resulting `runtime.env`
and run `npx vitest run tests/aws/super-agent-*.test.ts --no-file-parallelism`.

These proofs send signed synthetic GitHub, GitLab, and Slack events, execute real model
Turns, inspect saved state, and capture outgoing delivery. They do not install a
provider app or post to a real repository or channel. Watchdog probes inject
bounded failed and aged histories into their own API-created Sessions, then check
scheduled reporting and actual model retry and judgment. The retry proof captures
the answer in its original thread and replays the completed delivery job to check
for duplicate replies. Some probes temporarily
pause the disposable outbox consumer and restore it in cleanup; run these files
serially against an otherwise idle test stack. The credential echo endpoint accepts
only deployment-specific synthetic canaries. Destroy the stack after validation.

Set `AWS_E2E_WEBHOOK_CAPTURE_URL` to the disposable deployment's delivery capture
URL to include the optional webhook case. It registers a Session-created webhook,
checks delivery through `DELIVERY_CAPTURE_QUEUE_URL`, and removes its resources.
Use the deployment-owned capture endpoint; no real provider account is needed.

## Manual phases

### Deploy, test and remove fixtures

The live-E2E deploy helper reloads saved runtime configuration before updating an
existing deployment. OAuth app ARNs, webhook toggles and signing-secret paths, model
selection, and backend configuration survive a redeploy unless a supported environment
variable overrides them. Review the generated configuration before applying changes.

```bash
AWS_E2E_REAL_CODEX=true npm run aws:e2e:deploy -- DEPLOYMENT_ID
npm run aws:e2e:test -- DEPLOYMENT_ID
npm run aws:e2e:console:test -- DEPLOYMENT_ID
npm run aws:e2e:status -- DEPLOYMENT_ID
npm run aws:e2e:destroy -- DEPLOYMENT_ID
```

`runtime.env` records the Agents endpoint, control endpoint, region and deployment
identity. Retained installations created before the migration need an explicit
cutover and regenerated runtime configuration. Old provider bindings and schedule
payloads are not reinterpreted as new resources.

The deployment records account/region before apply so partial setup is recoverable.
Teardown verifies that identity, terminates only EC2 workers matching the deployment
and its exact launch template, waits for their termination, and removes runtime
Agents/connection credentials within the disposable deployment prefix. Production
resources and credentials are outside this cleanup.

Docker, AWS credentials, Terraform, an admitted model, ARM64 MicroVM availability
and an opted-in AWS account are prerequisites. LocalStack exercises local
provider/schedule coordination with fake execution; it cannot prove MicroVM or
model behavior.
