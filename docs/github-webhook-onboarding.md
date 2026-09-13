# Connect a GitHub webhook

A signed GitHub event starts a Session only when it matches an owned Agent/environment
binding. Rat Things keeps webhook verification, repository checkout and terminal Turn
notification as separate stages.

## Prerequisites

Deploy the [Agents API and execution backend](development-and-deployment.md), configure
an admitted model, and authenticate the Rat Things CLI as the operator who will own the
Sessions. The selected environment must support repository commands. Keep the GitHub
webhook, clone and comment credentials separate.

## Configure the webhook

Store a high-entropy signing secret, a repository-read token and a comment-write token
in Secrets Manager. Set these Terraform inputs to their ARNs:

- `github_webhook_secret_arn`
- `github_clone_token_secret_arn`
- `github_notify_token_secret_arn`

Set `github_comment_trigger` to a distinct non-empty trigger for this deployment. Keep
repository hosts allowlisted. Apply the deployment configuration using the normal
Terraform workflow; secret values must not enter Terraform variables or state.

In the repository's webhook settings, use the deployed `webhook_urls.github` output,
`application/json`, and the matching signing secret. Select pull-request and issue-comment
events. Keep separate hooks, secrets and destinations for development and production.

## Bind the repository to an Agent

Create an Agent with the model, instructions and tools appropriate for repository review.
Create an environment template with the required packages and network access. Save a binding
with those returned IDs as `github-binding.json`:

```json
{
  "version": "1",
  "sourceKind": "github",
  "selector": { "repository": "OWNER/REPOSITORY" },
  "agentId": "agent_example",
  "environment": {
    "type": "openai_hosted",
    "environment_template_id": "envtpl_example"
  }
}
```

```bash
rat-things bind-source --file github-binding.json
rat-things source-bindings
```

`openai_hosted` is the standard wire name for a managed environment. On this endpoint,
Rat Things provisions that environment in your AWS account. The authenticated operator owns
the binding and resulting Sessions. Generic repository selectors are trusted operator
configuration; they do not independently prove repository ownership.

A notification destination does not give the Agent GitHub write tools. Declare any desired
agent-callable operations separately on the Agent, with their own credentials and grants.

## Trigger the first response

Opening, reopening or updating a pull request, or marking it ready for review, submits a
review. A newly created pull-request comment containing the configured trigger submits a
question. Other signed event types are acknowledged and ignored.

The accepted receipt contains a Session ID. Inspect that Session's Turns and Items with the
standard API or CLI. The saved terminal root Turn supplies the result comment; worker exit
alone does not trigger another reply. Repeated delivery IDs are deduplicated. Repository
occurrences use separate Sessions so a later event cannot change an earlier checkout ref.

## Credential handling

The verifier reads only the signing secret. Trusted checkout uses the repository-read token;
terminal Turn delivery uses the notification token. Tokens never belong in clone URLs, bindings,
Agent instructions or webhook bodies. The current clone adapter consumes a configured token;
it does not mint GitHub App installation tokens from the event's installation ID.

## Troubleshooting

- A signed ping returns `202` with `ignored: true`; it does not execute an Agent.
- `source_not_bound` means no verified source selector matched an Agent/environment binding.
- `401` means signature verification failed. Check the configured secret and exact raw body.
- A failed Turn needs inspection through Session Items and worker diagnostics. A completed Turn
  with no comment needs delivery-fence and notification-credential inspection.
- An ambiguous comment outcome needs provider reconciliation before another write is attempted.

See [channel adapters](channels.md#github) for accepted event shapes and deployment controls.
