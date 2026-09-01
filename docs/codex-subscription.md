# Bring your Codex subscription to Rat Things

Bring the Codex access included with the ChatGPT plan already signed in on your computer. Rat Things
uses it locally first, then lets you hand work to isolated cloud agents when a task needs more time,
parallel workers, schedules, durable files, or connected services. The same ChatGPT/OpenAI path is
the default in both places; Amazon Bedrock is an opt-in alternative.

Rat Things does not need an OpenAI Platform API key for this path. OpenAI documents that Codex is
included with ChatGPT plans in the official [Codex pricing guide](https://learn.chatgpt.com/docs/pricing)
and documents ChatGPT sign-in in the official [Codex authentication guide](https://learn.chatgpt.com/docs/auth).
OpenAI also documents `cli_auth_credentials_store = "file"` plus `auth.json` in the official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Copying that
file into your AWS deployment is a Rat Things credential bridge, not a claim that OpenAI designed a
personal login as a general-purpose server credential.

## Fastest local path

Requirements: Node.js 22.20+, npm, Git, and a ChatGPT account with Codex.

```bash
git clone https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm ci
npm run codex:login
npm run rat-things -- "Inspect package.json and summarize this project"
```

`npm run codex:login` opens the official ChatGPT sign-in flow. The first Rat Things run is read-only
and does not give shell commands network access. Confirm the active authentication method with:

```bash
npm run codex:status
```

## Let local Codex edit the workspace

Opt into workspace writes for a task that should change files:

```bash
npm run rat-things -- local --sandbox workspace-write "Add a focused test for the parser"
```

Command network access remains off. Enable it only when the task needs it:

```bash
npm run rat-things -- local \
  --sandbox workspace-write \
  --network \
  "Update the dependency and verify its official migration guide"
```

Add `--events` to print the complete Codex JSONL event stream. Add `--workspace PATH` to work in a
different directory. Local execution supports Codex skills, apps, MCP, search, reasoning, and
personality flags. Multi-account Rat Connections and the isolated Chromium helper require the
deployed AWS host.

Local and remote execution both pin Codex to `approvalPolicy: "never"`. Narrow the sandbox,
networking, and selected capabilities before launch; Rat Things has no mid-Run approval path.

## Hand the same experience to AWS

First deploy the cloud handoff from the device where Codex is signed in:

```bash
npm run quickstart:aws -- \
  --profile rat-things-sandbox \
  --region us-west-2
```

The quickstart validates the local file-based ChatGPT login, shows the credential warning below,
and asks for separate consent before any credential copy. For unattended setup, acknowledgement is
deliberately explicit:

```bash
npm run quickstart:aws -- \
  --profile rat-things-sandbox \
  --region us-west-2 \
  --yes \
  --accept-codex-credential-risk
```

After deployment, hand work off explicitly:

```bash
rat-things handoff --thread release-readiness \
  "Run the release checks, keep the artifacts, and report back when complete"
```

Cloud agents can continue after the local turn ends, use installed Slack or Linear accounts, keep
files, and resume the same durable conversation later.

## Credential risk and lifecycle

The file bridge copies the validated ChatGPT-mode `auth.json` into AWS Secrets Manager. That file
contains bearer access and identity tokens, an account identifier, and a renewable refresh token.
It does not contain the ChatGPT password, MFA secret, or browser cookies, but possession can still
be enough to impersonate the Codex login, consume subscription usage, and reach Codex-visible data
or connectors. A short-lived access token does not remove this risk because the refresh token can
renew access.

Use the bridge only when all of the following are acceptable:

- the AWS account, Rat Things deployment, selected repositories, and agents are trusted;
- the ChatGPT account and available connectors contain no authority you are unwilling to expose to
  that trusted cloud runtime;
- the deployment is not an untrusted multi-tenant agent host; and
- you can remove the AWS copy and revoke account sessions if exposure is suspected.

Rat Things reduces, but cannot eliminate, the risk:

- the canonical AWS copy is encrypted in Secrets Manager and only its ARN crosses orchestration;
- the trusted runner writes `auth.json` with mode `0600` inside the MicroVM immediately before
  Codex starts;
- the unprivileged Codex process necessarily has access to that file while it runs;
- if Codex refreshes the login, the trusted runner writes the updated bundle back to Secrets
  Manager;
- the runtime copy is deleted after each turn; and
- if persistent S3 Files is enabled, the temporary Codex-home copy may transit that encrypted
  backing store during the active turn before deletion.

The credential never belongs in a Thing, Run request, DynamoDB record, log, Terraform state,
container image, or repository. An operator-managed deployment can provide an existing secret ARN
with `--codex-auth-secret-arn`; the secret must contain either raw `auth.json` or a JSON object with
an `auth_json`, `codex_auth_json`, or `auth` string field.

After signing in again locally or changing accounts, replace the AWS copy without redeploying:

```bash
npm run quickstart:aws -- sync-auth
```

The quickstart remembers the AWS profile and Region used during setup. It warns and asks for
credential-risk consent again. Quickstart-managed copies are removed by:

```bash
npm run quickstart:aws -- destroy
```

An ARN supplied with `--codex-auth-secret-arn` is operator-managed and is not deleted by quickstart
teardown. If compromise is suspected, destroy or delete the AWS secret first, then use ChatGPT's
account session controls to revoke access and sign in again. Local `npm exec -- codex logout`
removes the login from this device; do not rely on local file deletion alone to invalidate a stolen
copy.

## Headless or remote login

If the normal browser callback cannot reach the device, use Codex device authentication:

```bash
npm run codex:login -- --device-auth
```

Device authentication must be enabled in the ChatGPT account or workspace. Follow the printed URL
and one-time-code instructions. See OpenAI's
[headless-device login guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## Optional Bedrock provider

Amazon Bedrock is not the default. Select it only for a deployment that deliberately wants AWS
model access and billing:

```bash
npm run quickstart:aws -- --auth bedrock --region us-west-2
```

## Live verification status

On September 1, 2026, the file bridge completed a disposable live AWS working-tree canary in
`us-west-2`. A real Codex draft test and a second invocation of the published active revision both
succeeded with the same immutable revision and proof marker. The measured setup-through-second-Run
path took 521 seconds. The authenticated status check passed; teardown left zero Terraform state
entries and zero active MicroVMs; the quickstart reported its managed credential deleted, and an
independent Secrets Manager lookup returned `ResourceNotFoundException`. The source tree contained
the implementation changes under review, so this is live functional evidence rather than a
clean-commit release artifact.

## Troubleshooting

1. Run `npm run codex:status` and repeat `npm run codex:login` if no ChatGPT session is active.
2. If the quickstart cannot read `auth.json`, set Codex to file-backed credential storage or pass
   `--codex-auth-file PATH` to the file you deliberately exported for this bridge.
3. Confirm the selected ChatGPT account or workspace has Codex enabled and available usage.
4. Run `npm ci` again if the pinned `codex` executable is missing.
5. Leave `CODEX_CHATGPT_MODEL` unset unless the account exposes the exact model ID you configure.
6. If browser login cannot return to the machine, use `npm run codex:login -- --device-auth`.
