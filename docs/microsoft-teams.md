# Connect Rat Things to Microsoft Teams

Rat Things separates the immediate Teams acknowledgement from the potentially long-running agent
job:

```text
@Rat Things <prompt>
  -> immediate: "Rat Things request received. I'll reply when run <id> finishes."
  -> asynchronous agent run
  -> terminal result delivered through the configured Teams egress
```

Microsoft gives an outgoing webhook five seconds to return its synchronous response. The delayed
result therefore cannot come from that HTTP response after the connection closes.

## Choose a connection mode

| Mode | Available in this repository | Terminal result | Best use |
| --- | --- | --- | --- |
| Outgoing webhook + Workflow | Yes | Posts to a configured chat or channel, not necessarily the originating thread | Initial tenant integration and controlled deployments |
| Teams bot + threaded gateway | Gateway contract only | Replies to the originating activity | Production conversational experience after the gateway is implemented |

The LocalStack suite validates the complete threaded-gateway envelope, including the original
`conversationId` and `activityId`. It does not validate Microsoft identity, bot installation, or
live tenant delivery.

## Prerequisites

- A deployed Rat Things AWS stack and permission to update its Terraform configuration.
- Permission to manage apps for the target Teams team. Tenant policy must permit outgoing webhooks.
- AWS CLI access to the deployment account and permission to manage the intended Secrets Manager
  secrets.
- A public Teams channel for the current outgoing-webhook ingress. Outgoing webhooks do not support
  private channels, personal chat, or general messages without an `@mention`.
- For Workflow egress, permission to create a Teams Workflow and at least one co-owner for
  operational continuity.

Use a separate webhook, Workflow, and set of secrets for every Rat Things environment.

## 1. Bootstrap the ingress secret and deploy

The Teams callback URL exists only when the Teams route is enabled, while Teams reveals the real
HMAC secret only after the outgoing webhook is created. Bootstrap the AWS secret first, deploy the
route, and replace the secret value after Teams supplies it.

Create a Secrets Manager secret containing a temporary random value. This pipeline keeps the value
out of shell arguments and command history:

```bash
export RAT_THINGS_TEAMS_SECRET_ID="rat-things/dev/teams-outgoing"

openssl rand -base64 32 \
  | jq -Rn '{hmac_secret: input}' \
  | aws secretsmanager create-secret \
      --name "$RAT_THINGS_TEAMS_SECRET_ID" \
      --secret-string file:///dev/stdin
```

Record the returned ARN and configure `infra/terraform.tfvars`:

```hcl
teams_outgoing_webhook_secret_arn = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:rat-things/dev/teams-outgoing-SUFFIX"
teams_webhook_enabled              = true

# Start with the simple bridge. Configure its URL secret in the next section.
teams_delivery_mode = "workflow"
```

Do not put the HMAC value itself in Terraform, `.env`, a command-line argument, or source control.
Package and deploy the stack using the normal deployment flow:

```bash
npm ci
npm run package
terraform -chdir=infra init
terraform -chdir=infra plan -out=teams.tfplan
terraform -chdir=infra apply teams.tfplan
```

Read the callback URL from Terraform:

```bash
terraform -chdir=infra output -json webhook_urls | jq -r '.teams'
```

The expected path ends in `/webhooks/teams`.

## 2. Create the Teams outgoing webhook

In Microsoft Teams:

1. Open the target team, select **More options (...)**, and choose **Manage team**.
2. Open **Apps**. Under **Upload an app**, select **Create an outgoing webhook**.
3. Set the name to `Rat Things`. This becomes the name users mention.
4. Paste the Terraform-reported HTTPS callback URL, add a description and optional icon, and select
   **Create**.
5. Copy the HMAC security token from the confirmation dialog. Treat it as a password; Teams issues a
   unique token for this webhook.
6. In AWS Secrets Manager, replace the bootstrap secret value with this JSON shape:

   ```json
   {"hmac_secret":"<base64 HMAC token from Teams>"}
   ```

The Lambda resolves the secret on each invocation, so changing only the secret value does not
require another Terraform apply. Rat Things verifies HMAC-SHA256 over the exact raw request body
before parsing the activity.

## 3. Configure terminal-result delivery

### Option A: Teams Workflow bridge

This is the connection mode that can be completed with the current repository.

1. In the destination Teams chat or channel, open **Workflows**.
2. Choose **Post to a channel when a webhook request is received** (or the equivalent chat
   template), select the destination, and create the Workflow.
3. Because the current notifier authenticates with the secret callback URL rather than a Microsoft
   bearer token, select the trigger's **Anyone** authentication option. If tenant policy prohibits
   anonymous triggers, use the bot/gateway design below instead of weakening that policy.
4. Add at least one co-owner. Workflows belong to users and can otherwise become orphaned.
5. Copy the generated callback URL and store it in a separate Secrets Manager secret using this
   shape:

   ```json
   {"url":"<Teams Workflow callback URL>"}
   ```

6. Configure its ARN and apply Terraform:

   ```hcl
   teams_delivery_mode            = "workflow"
   teams_workflow_url_secret_arn  = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:rat-things/dev/teams-workflow-SUFFIX"
   ```

The callback URL contains a credential and must never be committed or logged. The notifier sends an
Adaptive Card with the run status, response, and run ID. The card appears in the Workflow's selected
destination; it is not guaranteed to be a reply to the original mention.

### Option B: exact delayed replies through a Teams bot

Use this mode only after deploying an authenticated AWS-hosted Teams bot gateway. The gateway itself
is not included yet; Rat Things currently provides and tests its internal delivery contract.

The Teams-facing implementation must:

1. Register a single-tenant Azure Bot or supported managed-identity bot, enable its Microsoft Teams
   channel, and install the corresponding Teams app in every permitted destination.
2. Receive and authenticate the original activity as that same bot identity. A different bot cannot
   safely assume an outgoing webhook's conversation reference is authorized for it.
3. Retain the activity's trusted `serviceUrl`, `conversation.id`, and `id`, bound to the tenant and
   installed bot identity.
4. Expose a private or strongly authenticated AWS gateway endpoint that accepts Rat Things'
   `reply-to-activity` envelope. Do not expose this as an unsigned public relay.
5. Acquire a Bot Connector access token and send the terminal activity to
   `/v3/conversations/{conversationId}/activities/{activityId}` using the original trusted
   `serviceUrl`. Enforce tenant allowlists and idempotency by run ID.

After that gateway exists, store its trusted AWS URL in Secrets Manager:

```json
{"url":"https://<private-or-authenticated-gateway>/teams/replies"}
```

Then configure and apply:

```hcl
teams_delivery_mode                     = "threaded-gateway"
teams_reply_gateway_url_secret_arn      = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:rat-things/dev/teams-reply-gateway-SUFFIX"
```

Named Workflow routes are intentionally rejected in `threaded-gateway` mode. See
[Channel adapters](channels.md#threaded-reply-gateway-contract) for the versioned envelope.

## 4. Verify the live connection

Test in a non-production team with a small mock or Codex canary:

1. Post `@Rat Things Reply with the marker TEAMS_CANARY_001` in a supported public channel.
2. Confirm the original chain receives
   `Rat Things request received. I'll reply when run <id> finishes.` within five seconds.
3. Confirm exactly one run with source kind `teams` is persisted and reaches a terminal state.
4. In Workflow mode, confirm one Adaptive Card appears in the configured destination. In threaded
   mode, confirm the completed result is a reply to the original activity.
5. Repeat the signed delivery or exercise a provider retry and confirm the run ID and terminal
   notification are deduplicated.
6. Review CloudWatch without printing activity bodies, HMAC values, Workflow URLs, access tokens, or
   model credentials.

Before using real model tokens, validate the same data path locally:

```bash
npm run test:e2e:localstack
```

To use the signed-in Codex subscription while keeping Teams and AWS egress simulated:

```bash
npm exec -- codex login
npm run test:e2e:teams:codex
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Teams reports that the webhook is unavailable | Callback URL is the current stack output, the route is deployed, and tenant policy allows outgoing webhooks |
| `401 invalid_signature` | Secret value is the exact base64 token from this outgoing-webhook installation; the raw request was not rewritten by a proxy |
| No immediate acknowledgement | API Gateway/Lambda latency stayed under Teams' five-second deadline and durable S3/DynamoDB/SQS submission succeeded |
| Acknowledgement appears but no terminal card | Run reached a terminal state, Workflow URL secret is current, EventBridge/notifier retries are healthy, and the flow is enabled |
| Workflow returns `401` or `403` | Trigger authentication matches the notifier; the shipped adapter does not attach a Microsoft user bearer token |
| Result appears in the wrong place | Workflow mode targets its configured destination; use a completed bot gateway for exact-thread delivery |
| Gateway receives the envelope but Teams rejects it | Bot is installed, token audience and tenant are correct, and the stored `serviceUrl` and conversation reference belong to that bot identity |

## Microsoft references

- [Create an outgoing webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook)
- [Teams webhook trigger and authentication options](https://learn.microsoft.com/en-us/connectors/teams/#when-a-teams-webhook-request-is-received)
- [Register and configure a Teams bot](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/add-authentication)
- [Bot Connector reply-to-activity API](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference?view=azure-bot-service-4.0#reply-to-activity)
- [Send and receive Bot Connector messages](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages?view=azure-bot-service-4.0)
