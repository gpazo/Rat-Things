# Channel adapters

All channel integrations translate authenticated external events into the same v1 run request. They
do not bypass validation or create a separate execution path.

Normalized channel requests set `sandbox: read-only` but do not select a driver. Dispatch therefore
uses `default_agent_driver`: the shipped/example `mock` default keeps webhook and chat canaries
deterministic and model-token-free until an operator explicitly switches the deployment to `codex`.

The adapters intentionally separate:

- the **source identity** authenticated by the inbound request;
- the **destination identity** selected for a terminal response; and
- the **credential identity** used for repository access or outbound provider APIs.

A delivery route is an opaque local name or provider channel ID. It is never a webhook URL, token,
owner ID, or Secrets Manager ARN supplied by an untrusted user.

Use `terraform -chdir=infra output -json webhook_urls` to obtain enabled endpoints. The paths are
`POST /webhooks/github`, `/webhooks/gitlab`, `/webhooks/teams`, and `/webhooks/slack`; a route exists
only when its ingress secret ARN is configured. The API hostname changes per stack, so do not copy a
URL from another environment.

## Secret formats

Secrets Manager values may be raw strings or the following JSON shapes:

| Setting | Accepted JSON keys |
| --- | --- |
| GitHub webhook secret | `secret`, `webhook_secret` |
| GitHub clone/comment token | `token`, `access_token` (`password` is also accepted by clone only) |
| GitLab signing/legacy token | `signing_token`, `token`, `secret`, `webhook_secret` |
| GitLab clone/note token | `token`, `access_token` (`password` is also accepted by clone only) |
| Teams outgoing-webhook HMAC secret | `secret`, `hmac_secret` |
| Teams Workflow URL | `url`, `webhook_url` |
| Teams threaded-reply gateway URL | `url`, `webhook_url` |
| Slack signing secret | `secret`, `signing_secret` |
| Slack bot token | `token`, `bot_token` |

Keep ingress, clone, and outbound API credentials in different secrets. The module exposes split
clone/notification ARNs. Its deprecated `github_token_secret_arn` and `gitlab_token_secret_arn`
fallbacks reuse one token only for migration compatibility; do not use them in a new deployment. Pin
IAM policies to exact secret ARNs.

## GitHub

### Current behavior

The GitHub Lambda validates `X-Hub-Signature-256` over the exact raw request body using HMAC-SHA256
before parsing JSON. `X-GitHub-Delivery` is the provider event identity and idempotency source.

Accepted events are:

| GitHub event | Accepted actions | Result destination |
| --- | --- | --- |
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review` | PR issue comment |
| `issue_comment` | `created`, only when the issue is a PR and body contains the configured trigger | PR issue comment |

Other validly signed events return `202` with `{"accepted":false,"ignored":true}`. The review
request checks out the head SHA read-only and fetches the base ref for diff context. Comment requests
are case-insensitively gated by `github_comment_trigger` (injected as
`GITHUB_COMMENT_TRIGGER`; `@indubitably` by default). This is a cost
and noise filter, not authorization: anyone allowed to comment can include the trigger. Retain event,
installation, repository, rate, and budget controls.

The normalizer requires the configured trigger to be non-empty. Provider result replies include the
hidden `indubitably-agent-runtime:result` marker, and ingress ignores marked replies and comments
whose GitHub user type is `Bot`. These controls prevent the runtime's ordinary result replies from
starting another run even when generated text repeats the trigger. They do not authorize human
authors; keep repository, actor, budget, and rate policy separate.

### Configure GitHub

1. Create a high-entropy webhook secret, a clone-only credential, and a separate comment-only
   credential in Secrets Manager.
   The current implementation consumes a static token; `installationId` is retained as source
   metadata but the runtime does not yet mint short-lived GitHub App installation tokens.
2. Set `github_webhook_secret_arn`, `github_clone_token_secret_arn`, and
   `github_notify_token_secret_arn`. Limit each token independently to the intended repositories and
   its one operation; leave the deprecated combined `github_token_secret_arn` null.
3. In the GitHub App or repository webhook, set the payload URL to the stack's GitHub webhook output,
   content type to `application/json`, and secret to the same ingress secret value.
4. Set a distinct command-like `github_comment_trigger`, and subscribe only to pull-request and
   issue-comment events. Use a separate App/webhook per environment
   so delivery IDs, permissions, URLs, and secrets do not cross dev/prod boundaries.
5. Send a GitHub “ping”/test delivery and confirm the Lambda log shows an authenticated ignored or
   accepted event without logging the body or secret. Then open a test PR and verify the run record,
   one worker execution, and one comment.

For `issue_comment`, the adapter checks out `refs/pull/<number>/head` so follow-up questions inspect
the pull request rather than the repository's default branch. That synthetic ref is mutable; a future
adapter should resolve it to a commit SHA at authenticated ingress when exact replay reproducibility is
required.

GitHub signs webhook deliveries as documented in
[Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
Use a GitHub App with short-lived installation tokens as the production credential design; the static
token adapter is an explicit maturity gap.

For GitHub Enterprise Server, add its clone hostname to `allowed_repository_hosts` and set the
validated `github_api_base_url` input to that installation's REST `/api/v3` endpoint. The public
default is `https://api.github.com`. Keep both values environment-specific and integration-test clone
and `source` delivery together.

## GitLab

### Current behavior

For GitLab 19 Standard Webhooks, the Lambda requires `webhook-id`, a `webhook-timestamp` within five
minutes, and at least one matching `v1,<base64>` entry in `webhook-signature`. It strips the `whsec_`
prefix from the configured signing token, strictly decodes its 32-byte key, and verifies HMAC-SHA256
over `webhook-id.webhook-timestamp.raw-body` with a timing-safe comparison before parsing JSON. A
present but invalid Standard signature is rejected; it never downgrades to legacy auth.

When no `webhook-signature` header is present, the handler retains `X-Gitlab-Token` timing-safe
comparison for older GitLab installations. This legacy token authenticates a shared value but does
not sign the body or provide timestamp replay protection; do not choose it for a new GitLab 19+
webhook.

Idempotency prefers `webhook-id`, then `Idempotency-Key`, `X-Gitlab-Webhook-UUID`, `X-Request-ID`, and
finally a SHA-256 hash of the raw body.

Accepted payloads are:

| GitLab object kind | Accepted actions | Result destination |
| --- | --- | --- |
| `merge_request` | `open`, `reopen`, `update`, `approved` (or omitted action) | Merge-request note |
| `note` | Note attached to a merge request whose body contains the configured trigger | Merge-request note |

Other authenticated payloads return an accepted/ignored response. GitLab note requests are
case-insensitively gated by `gitlab_comment_trigger` (injected as `GITLAB_COMMENT_TRIGGER`;
`@indubitably` by default). The trigger controls
noise/cost but is not proof that the author is authorized for a particular repository or destination.

The normalizer requires the configured trigger to be non-empty. Provider result notes include the
hidden `indubitably-agent-runtime:result` marker, and ingress ignores marked replies and payload users
whose GitLab `bot` field is true. These controls prevent ordinary self-trigger loops even when
generated text repeats the trigger. They do not authorize human authors; keep project, actor, budget,
and rate policy separate.

### Configure GitLab

1. On GitLab 19+, generate a signing token (`whsec_...`) for the webhook and store it separately from
   a least-privileged project/group access token in Secrets Manager. Use a legacy secret token only
   for an older installation that cannot emit Standard Webhooks headers.
2. Set `gitlab_webhook_secret_arn`, `gitlab_clone_token_secret_arn`, and
   `gitlab_notify_token_secret_arn`; leave the deprecated combined `gitlab_token_secret_arn` null.
3. Set a distinct command-like `gitlab_comment_trigger`. Add a project or group webhook using the
   Terraform-reported GitLab webhook URL and the matching secret token. Enable merge-request events
   and comments/notes only.
4. Restrict the API credential to read repository and create merge-request notes for the intended
   projects. Do not embed it in the clone URL.
5. Test in a non-production project. Confirm a redelivery maps to the same run ID and does not create a
   duplicate note.

GitLab documents the signing-token format, Standard Webhooks headers, multi-signature verification,
timestamp, idempotency header, and legacy-token warning under
[Webhook configuration](https://docs.gitlab.com/user/project/integrations/webhooks/).

For GitLab Self-Managed, add its clone hostname to `allowed_repository_hosts` and set the validated
`gitlab_api_base_url` input to that installation's REST `/api/v4` endpoint. The public default is
`https://gitlab.com/api/v4`. Keep both values environment-specific and integration-test clone and
`source` delivery together.

## Microsoft Teams: primary channel, bridge implementation

Teams is the preferred chat surface for this subsystem, but the repository currently implements two
temporary adapters:

For deployment instructions, secret formats, and a live-tenant verification checklist, see
[Connect Rat Things to Microsoft Teams](microsoft-teams.md).

```text
Teams @mention
  -> Teams outgoing webhook (HMAC)
  -> API Gateway + webhook Lambda
  -> durable submission, then queued-run acknowledgement (five-second provider deadline)

terminal run event
  -> notifier
  -> Teams Workflow incoming URL
  -> Adaptive Card in the Workflow's configured destination
```

### Current outgoing-webhook ingress

Create an outgoing webhook for the target team, store the base64 HMAC secret Teams returns in
Secrets Manager, and configure its callback URL from the Terraform output. The handler validates the
`Authorization: HMAC ...` signature, removes the bot mention/HTML, durably writes S3/DynamoDB/SQS,
and then returns `Rat Things request received. I'll reply when run <id> finishes.` in the original
reply chain. Completion is asynchronous through the configured Workflow or threaded gateway. The
normalizer requires both the provider tenant ID and sender ID and derives ownership as
`teams:<tenant>:<sender>`; a signed activity missing either identity is rejected. The
handler is configured with a five-second timeout, so the synchronous persistence path does not
guarantee an acknowledgement under cold-start or AWS-service latency; this is another reason to
replace the bridge with a production gateway/ingest design.

This adapter inherits the documented Teams outgoing-webhook constraints:

- it is team-scoped and works only in public channels;
- it is reactive to an `@mention`, not a general bot conversation;
- it must return synchronously within five seconds;
- it cannot access Teams APIs such as the roster or channel list; and
- card actions are limited.

See Microsoft's [Create an outgoing webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook).

### Current Workflow egress

Create a Teams Workflow using an incoming-webhook trigger, grant it only the intended channel, and
store its default URL through `teams_workflow_url_secret_arn`. For named destinations, map opaque
route names to Workflow URL secret ARNs with `teams_route_secret_arns`; Terraform injects the map as
`TEAMS_ROUTES_JSON`. Callers receive route names, never URLs or ARNs. An unknown named route is
rejected rather than falling back to the default.

The notifier sends an Adaptive Card containing terminal status, a truncated body, and run ID. It
does not use the inbound `conversationId` to post a proactive reply. Consequently, a `source`
destination means “the configured Teams Workflow destination,” which may not be the exact originating
thread.

Microsoft recommends Workflows as the successor path while legacy Microsoft 365 connectors approach
retirement, but Workflows still have operational constraints: flows are owned by specific users and
can become orphaned without co-owners, private-channel support is limited, and webhook-trigger/card
features do not equal a full bot. Review
[Create incoming webhooks with Workflows](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using)
and the [Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/).

Treat the Workflow URL as a bearer credential. Rotate it on exposure, assign co-owners, monitor flow
failures/throttling, and keep dev/prod flows separate.

### Threaded reply gateway contract

Set `teams_delivery_mode = "threaded-gateway"` and configure
`teams_reply_gateway_url_secret_arn` to route source replies through a trusted gateway instead of a
Workflow. The notifier posts a versioned envelope containing the original `conversationId`, the
inbound activity ID as `replyToActivityId`, a Bot Activity-shaped message with `replyToId`, and the
run ID as an idempotency key. Named Workflow routes are rejected in this mode.

The LocalStack real-Codex test captures this envelope and proves that the conversation/activity
reference survives signed ingress, persistence, execution, terminal events, and delivery fencing.
The URL is still a credential and must point only at infrastructure controlled by the deployment.
This repository does not yet implement the gateway's Microsoft Entra token exchange, Bot Connector
authentication, or live tenant installation.

### Recommended production Teams gateway

Replace the bridge—not the v1 run contract—with an AWS-hosted Teams app/bot gateway:

1. Register a Microsoft Entra/Bot identity and Teams app. Point its HTTPS messaging endpoint at an
   API Gateway/Lambda adapter in this repository.
2. Validate Bot Framework service JWTs (issuer, audience, lifetime, signing keys) and enforce tenant
   allowlists before creating a trusted Teams source. Do not treat activity JSON fields as proof of
   identity.
3. Use the [Teams SDK](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/) for the
   Teams-facing gateway. The JavaScript and C# SDKs are GA; verify language status before choosing an
   implementation.
4. Store an authorized conversation reference when the app is installed or messaged. Map it to a
   server-side destination ID; never accept a raw callback URL or arbitrary conversation ID as a
   public run destination.
5. Submit through a privileged internal adapter that preserves the authenticated Teams source. The
   general control API deliberately overwrites `source` and is not a substitute for this trust
   boundary.
6. On terminal events, obtain an app/service token and send a proactive message to the stored
   conversation. The app must already be installed in the destination. Follow Microsoft's
   [proactive messaging rules](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
   and [Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0).

This keeps AWS as the compute/data plane while using the Microsoft identity and messaging plane that
Teams requires. It enables tenant policy, installation lifecycle, exact conversation references,
proactive completion, and future approvals without coupling runs to a Power Automate owner.

## Slack: optional adapter

Slack is supported as an optional compatibility surface, not the primary product direction. The
ingress validates Slack v0 signatures and rejects timestamps with more than five minutes of skew. It
answers URL-verification challenges and accepts only `app_mention` events. Mentions carrying
`bot_id`, `bot_profile`, or the `bot_message` subtype are ignored so the adapter does not consume its
own bot output. Results use `chat.postMessage`, preserving the source thread when one exists.

Like the Teams bridge, Slack currently performs secret resolution plus durable S3/DynamoDB/SQS
submission before acknowledging the event, inside a five-second Lambda timeout. Slack requires an
HTTP 2xx within **three seconds** and recommends acknowledging before processing; this synchronous
path can therefore time out at Slack and cause provider retries even when AWS later accepted the run.
Idempotency limits duplicate runs, but not latency or retry noise. Treat an acknowledge-first durable
ingress queue/worker split as a production requirement and validate cold starts against Slack's
[Events API response contract](https://docs.slack.dev/apis/events-api/).

To enable it:

1. Create a Slack app with an event request URL from the Terraform output, subscribe to
   `app_mention`, and install it in the intended workspace.
2. Store the signing secret and a separate bot token in Secrets Manager.
3. Grant only the scopes required to receive mentions and post messages, configure the two secret
   ARNs, and leave the adapter disabled/unrouted when Slack is not used.
4. Test URL verification, a mention, one threaded result, a replayed event, and a stale signature.

Slack event IDs are the idempotency source. Accepted mentions require both `team_id` and the event's
user ID, deriving ownership as `slack:<team>:<user>`; missing identity is ignored. Destination
channel/thread metadata does not establish the run owner and the bot token does not establish the
inbound sender.
