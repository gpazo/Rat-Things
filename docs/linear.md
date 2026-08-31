# Connect Rat Things to Linear

Linear is a built-in Rat Things Connection. An agent can search and inspect issues, discover team
and workflow-state IDs, create or update issues, and add comments through a verified Linear
workspace account. The same Connection works from a CLI conversation, Slack thread, Thing,
Routine, product API, or another agent.

This guide sets up a deployment-owned Linear OAuth application, installs one workspace, and runs a
bounded Slack-to-Linear handoff. Rat Things uses Linear's app actor, so writes appear as the
installed application rather than impersonating the workspace admin who grants consent.

> This is currently a connected-service integration, not Linear-native Run ingress. Do not enable
> Agent session event webhooks or request `app:assignable` or `app:mentionable`: assigning or
> mentioning Rat Things inside Linear does not start a Run yet.

## What the built-in Connection can do

| Operation | Access | Purpose |
| --- | --- | --- |
| `linear.teams.list` | Read | List visible teams and their workflow states so later calls can use provider IDs |
| `linear.issues.search` | Read | Search issue text, optionally within one team |
| `linear.issues.get` | Read | Read one issue and the first page of up to 20 comments |
| `linear.issues.create` | Write | Create an issue in one team with a title and optional Markdown description |
| `linear.issues.update` | Write | Change an issue title, description, state, or assignee |
| `linear.comments.create` | Write | Add a Markdown comment to an issue |

The adapter sends fixed GraphQL documents only to `https://api.linear.app/graphql`. The model
cannot supply a query document, provider origin, OAuth scope, or credential. Linear provider
authority, the persistent Rat grant, the capability profile, and per-Run operation/resource
narrowing must all admit a call before the host credential broker reads the token.

## Before you start

You need:

- a deployed Rat Things AWS stack and an authenticated CLI;
- workspace-admin access in the Linear workspace that will install the app;
- permission to create and read one AWS Secrets Manager secret in the stack Region; and
- the same Terraform checkout and variables used for that deployment.

Linear's current OAuth flow supports PKCE and rotating refresh tokens. Rat's callback already
implements one-time state, S256 PKCE, code exchange, refresh fencing, and identity-preserving
reconnection. The provider details used here come from Linear's
[OAuth 2.0 guide](https://linear.app/developers/oauth-2-0-authentication) and
[app-actor guide](https://linear.app/developers/oauth-actor-authorization).

## 1. Read the deployment callback URL

OAuth configuration is intentionally a second step after the base stack exists:

```bash
terraform -chdir=infra output -raw oauth_callback_url
```

Copy the complete HTTPS URL. Do not shorten it, add a path, or substitute a console URL.

## 2. Create the Linear OAuth application

In Linear, open **Workspace settings → API → OAuth applications**, then create an application:

1. Use a recognizable name such as **Rat Things** and describe the workspace actions it performs.
2. Register the exact callback URL from step 1 as a redirect URI.
3. Keep the application private unless you intend to operate the provider review and support path
   for other Linear workspaces.
4. Leave webhooks disabled for this integration. The current built-in does not consume Linear
   issue, comment, or Agent Session events.
5. Save the application, then copy its client ID and client secret into a temporary
   owner-readable file.

The compiled Rat manifest—not the CLI or browser—adds `actor=app`, `prompt=consent`, and scopes
`read,write` to the authorization request. `read` is needed for workspace identity, teams, search,
issues, and comments. `write` is provider authority for the three reviewed write operations; it
does not expose arbitrary Linear mutations to the agent.

## 3. Store the OAuth application credential in AWS

Create a local file outside the repository:

```json
{
  "client_id": "replace-with-linear-client-id",
  "client_secret": "replace-with-linear-client-secret"
}
```

Put it in Secrets Manager without placing either value in Terraform or a shell argument:

```bash
aws secretsmanager create-secret \
  --name rat-things/linear-oauth-app \
  --secret-string file:///secure/tmp/linear-oauth-app.json \
  --region us-west-2
```

Retain the returned secret ARN, remove the temporary file through your normal secure cleanup
process, and do not commit it. The secret contains the deployment-owned OAuth application
credential, not a workspace access token.

## 4. Enable Linear OAuth in the deployment

Add only the secret ARN to the existing map in the deployment's Terraform variables:

```hcl
integration_oauth_app_secret_arns = {
  linear = "arn:aws:secretsmanager:us-west-2:111122223333:secret:rat-things/linear-oauth-app-AbCdEf"
  # Keep any existing providers, for example slack = "arn:...".
}
```

Package and apply the reviewed checkout using the deployment's normal process. Then confirm the
catalog exposes Linear and reports OAuth as configured:

```bash
rat-things plugins --json
```

The `linear` manifest should show `oauthInstallation.status` as `configured` and the exact callback
URL. A `host-required` status means the ARN map has not reached the control plane.

## 5. Install the Linear workspace

Start consent from the authenticated Rat owner that should own the Connection:

```bash
rat-things connect linear --oauth --wait \
  --access read-write \
  --alias linear-work
```

The CLI opens a ten-minute authorization URL. A Linear workspace admin chooses the workspace and
approves the app installation. Add `--no-browser` on a headless host and open the printed URL in a
browser; omit `--wait` if the initiating shell should return immediately.

After the callback, Rat queries Linear's `viewer` and `organization` fields before storing the
issued token. The Connection label is derived from that response, and its stable workspace and app
user IDs are recorded separately. Neither token nor secret value is returned.

## 6. Verify the installed identity and access

```bash
rat-things connection show linear-work
rat-things connection test linear-work
rat-things connection consumers linear-work
```

Check that the workspace label and provider scopes are expected, health is `healthy/verified`, and
the Rat grant is `read-write`. Start with `--access read-only` instead when a workflow needs only
team discovery, search, and issue inspection.

To reconnect an expired or revoked authorization without changing the alias, grant, or consumers:

```bash
rat-things connection reconnect linear-work --oauth --wait
```

Rat accepts the replacement only if Linear resolves it to the same workspace and app-user IDs.

## 7. Run the Slack-to-Linear demo

With a separately installed `slack-work` Connection, allow one Slack read and only the Linear
operations needed for the handoff:

```bash
rat-things chat --thread renewal-handoff \
  --connection slack-work=read-only \
  --allow-operation slack-work=slack.messages.search \
  --connection linear-work=read-write \
  --allow-operation linear-work=linear.teams.list,linear.issues.search,linear.issues.create,linear.comments.create \
  "Find the approved renewal decision in Slack. Check Linear for an existing matching issue. If none exists, create one in the customer-ops team with the open security items and source context, then add a comment summarizing what you did. Return the Linear identifier and URL."
```

Review the Run's durable tool-call ledger as well as the resulting Linear issue. The expected shape
is one Slack search, team discovery if the agent did not already have a team UUID, a Linear search,
and at most one issue creation plus one comment. If a matching issue exists, this exact envelope
does not include `linear.issues.update`, so the agent must report that boundary rather than changing
the issue.

For a strictly read-only proof:

```bash
rat-things chat --thread linear-read-proof \
  --connection linear-work=read-only \
  --allow-operation linear-work=linear.teams.list,linear.issues.search,linear.issues.get \
  "Find the most relevant renewal issue and summarize its current state and unresolved comments. Do not change Linear."
```

## Live AWS proof

On August 30, 2026 PDT, retained deployment `oauth260827a` completed the entire path against a real
private Linear workspace:

1. A workspace admin authorized the **Rat Things** OAuth app through the deployment's public PKCE
   callback. Rat verified the workspace and app-user identity, then reported `linear-work` healthy.
2. A real Codex Run inside an ARM64 Lambda MicroVM called `teams.list`, `issues.create`,
   `issues.update`, `comments.create`, and `issues.get` exactly once each.
3. Linear returned issue **IND-6**. The app actor created the issue and its proof comment, and the
   final read returned the updated provider state.
4. The durable Run ledger settled all five calls as `succeeded`; no OAuth token entered the prompt,
   workspace, Run request, or tool result.
5. A fresh read-only Run exposed search/get only, explicitly reported that creation was unavailable,
   and recorded no write call.

The first write canary also did useful release work: it exposed a broker compatibility gap when the
agent emitted an object operation's schema-equivalent fields without the usual `input` wrapper. The
host now normalizes that safe shape, still rejects unknown keys, and the fixed image passed the full
provider read-back on the next Run.

[Watch the 39.4-second proof](linear-live-aws-e2e.mp4), inspect the
[real Linear result](linear-live-issue.png), or open the
[five-call durable receipt](linear-live-write-run.png). The companion
[launch-copy sheet](linear-live-demo-social.md) includes X copy, website copy, alt text, and asset
filenames.

To record the same console journey against an already-installed disposable Connection:

```bash
AWS_E2E_LINEAR_CONNECTION_ALIAS=linear-work \
AWS_E2E_LINEAR_MARKER=RT-LINEAR-LIVE-20260831-FINAL \
./scripts/aws-e2e-linear-demo.sh oauth260827a
```

The script is evidence capture, not a mock: it reads the live Connection and durable conversations
from AWS, asserts the five-call write receipt and the read-only denial receipt, then records the
console to `assets/linear-live-aws-console.mp4`.

## Optional personal API key path

For one trusted operator workspace, the built-in also accepts a Linear personal API key. Put
`{"api_key":"..."}` in an owner-readable credential file and install it explicitly:

```bash
rat-things connect linear --auth-scheme api-key \
  --credential-file /secure/tmp/linear-api-key.json \
  --access read-only \
  --alias linear-personal
```

Linear personal keys are broad and do not report granular OAuth scopes. Prefer OAuth for a shared
or long-lived deployment, and keep the Rat grant and per-Run operation list narrow either way.

## Current boundaries

- Linear cannot yet start or continue a Rat conversation through mentions, issue delegation, or
  Agent Session prompts.
- Rat does not emit Linear Agent Activities or use Linear's native agent-session progress UI.
- Issue deletion, archival, labels, projects, cycles, attachments, relations, and administrative
  operations are not installed.
- Search returns at most 20 ranked issue summaries; issue inspection returns the first page of up
  to 20 comments.
- Write calls are autonomous inside the fixed Run envelope. There is no mid-Run approval prompt.

Linear documents its GraphQL endpoint, issue queries/mutations, and error envelopes in its
[GraphQL guide](https://linear.app/developers/graphql). When native Linear ingress is added, it must
also follow Linear's signed raw-body and timestamp checks from the
[webhook guide](https://linear.app/developers/webhooks), acknowledge within five seconds, and keep
ingress separate from agent execution and result delivery.

For the shared account model, see [Integrations, accounts, and permissions](plugins.md). For Run
authority, see [The fixed capability envelope](capability-envelope.md).
