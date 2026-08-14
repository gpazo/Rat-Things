# Use your Codex subscription

Yes—Rat Things can use the Codex access included with your ChatGPT plan for trusted local runs. You
sign in through OpenAI's official browser flow, and Rat Things launches its pinned Codex CLI with
the built-in OpenAI provider. You do not need a Platform API key or an Amazon Bedrock account for
this path.

Use a ChatGPT plan and workspace where Codex is enabled. Plan and workspace usage limits still
apply; see the official [Codex pricing](https://learn.chatgpt.com/docs/pricing) and
[authentication](https://learn.chatgpt.com/docs/auth) documentation.

## Fastest path

Requirements: Node.js 20+, npm, Git, and a supported ChatGPT account.

```bash
git clone https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm ci
npm run codex:login
npm run rat-things -- local "Inspect package.json and summarize this project"
```

`npm run codex:login` opens the ChatGPT sign-in flow in your browser. The first run is read-only and
does not give shell commands network access.

Confirm which authentication method is active at any time:

```bash
npm run codex:status
```

## Let Codex edit the workspace

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

Add `--events` to either form to print the complete Codex JSONL event stream. Add `--workspace PATH`
to work in a directory other than the repository root.

## What the command does

`npm run rat-things -- local` runs the repository's local runtime with:

- the real Codex driver;
- ChatGPT subscription authentication;
- Codex's built-in OpenAI model provider;
- the model available to the signed-in account unless `CODEX_CHATGPT_MODEL` is explicitly set;
- a read-only filesystem sandbox by default; and
- command network access disabled by default.

After `npm run build && npm link`, the shorter
`rat-things local "Inspect package.json and summarize this project"` form is equivalent. Local runs
default to the real Codex driver and ChatGPT authentication. Use `--driver mock` for deterministic
testing. Pass `--codex-auth bedrock` or set `CODEX_AUTH_MODE=bedrock` only when intentionally
testing the unattended AWS provider path.

## Headless or remote login

If the normal browser callback cannot reach the device, use Codex device authentication:

```bash
npm run codex:login -- --device-auth
```

Device authentication must be enabled in the ChatGPT account or workspace. Follow the printed URL
and one-time-code instructions. The official [Codex authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
documents other fallback options.

## Credential boundary

ChatGPT credentials stay on the trusted device that completed `codex login`. Codex normally caches
them in the operating-system credential store or under `~/.codex`; treat file-based credentials as
secrets.

Rat Things deliberately does **not** copy your personal Codex authentication cache into Lambda
MicroVMs, Terraform, DynamoDB, S3, run requests, or container images. Unattended AWS execution uses
short-term Bedrock authentication instead. This separation prevents repository-controlled agent
code from obtaining a reusable personal account credential.

To clear the local session, run:

```bash
npm exec -- codex logout
```

## Troubleshooting

1. Run `npm run codex:status` and repeat `npm run codex:login` if no ChatGPT session is active.
2. Confirm the selected ChatGPT workspace has Codex enabled and available usage.
3. Run `npm ci` again if the pinned `codex` executable is missing.
4. Leave `CODEX_CHATGPT_MODEL` unset unless the account exposes the exact model ID you configure.
5. If browser login cannot return to the machine, use `npm run codex:login -- --device-auth`.
