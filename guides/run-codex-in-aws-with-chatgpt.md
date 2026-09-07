# How to run Codex in AWS with your ChatGPT subscription

Codex supports signing in with ChatGPT for subscription access, and its CLI can keep that login in
a local `auth.json` file. To use the same identity inside self-hosted AWS compute, Rat Things
deliberately copies a validated file-backed login into AWS Secrets Manager, materializes it only for
the active Codex process, persists token refreshes, and removes the runtime copy afterward. This is
a Rat Things credential bridge—not an OpenAI recommendation to treat a personal login as a general
server credential.

> **Short answer:** it works for trusted, owner-operated agents, but the copied file contains
> renewable bearer credentials. Treat the AWS copy like a password and do not use this pattern for
> untrusted tenants.

## Understand the supported sign-in behavior

The official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth) describes
ChatGPT sign-in for subscription access, API-key sign-in for usage-based access, and enterprise
Codex access tokens or workload identity for qualifying trusted automation. OpenAI's
[non-interactive guidance](https://learn.chatgpt.com/docs/non-interactive-mode) says API keys are
the normal automation default and treats ChatGPT-managed account authentication in CI/CD as an
advanced path for trusted runners, excluding public or open-source repository CI workflows.
Device-code login and copying a file-backed `auth.json` remain documented headless
ChatGPT-login options. The file contains access tokens and must be protected like a password.

Rat Things builds on that documented local storage option. The additional transfer into Secrets
Manager, remote materialization, refresh persistence, and teardown behavior belong to Rat Things.
OpenAI does not need to have designed personal credentials for arbitrary server workloads for the
bridge to function, but that distinction matters when deciding whether its risk is acceptable.

## Distinguish Codex options relevant to Rat Things

| Authentication method | Codex supports it | Rat Things supports it | Best fit |
| --- | --- | --- | --- |
| ChatGPT file bridge | Yes; file copy is a documented headless fallback | **Yes; current quickstart default** | Trusted personal or owner-operated automation |
| OpenAI API key | Yes; recommended by OpenAI for programmatic Codex CLI workflows | **No; not implemented in Rat Things** | Usage-based service workloads outside the current Rat Things provider choices |
| Enterprise Codex access token or workload identity | Yes, for eligible trusted enterprise automation | **No; not implemented in Rat Things** | Private CI or cloud runners that should avoid a stored personal login |
| Amazon Bedrock | Through Codex's alternative-provider configuration | **Yes; explicit opt-in** | AWS-centered model access and billing |

Rat Things currently accepts only `chatgpt` and `bedrock` as cloud authentication modes. The API-key
and enterprise rows explain broader Codex choices; they are not claims that Rat Things can deploy
those modes.

## Prepare the local login

Use Node.js 22.20 or newer, npm, Git, and a ChatGPT account with Codex access:

```bash
git clone https://github.com/gpazo/Rat-Things.git
cd Rat-Things
npm ci
npm run codex:login
npm run codex:status
```

The login command opens the official ChatGPT sign-in flow and requests file-backed credential
storage. Confirm that local execution works before involving AWS:

```bash
npm run rat-things -- \
  "Inspect package.json and summarize this project"
```

That initial local run is read-only and does not give shell commands network access.

## Deploy the bridge deliberately

Use a disposable AWS sandbox account or isolated sandbox role for the first proof:

```bash
npm run quickstart:aws -- \
  --profile rat-things-sandbox \
  --region us-west-2
```

Before writing to AWS, the quickstart reports the selected account, Region, MicroVM image,
credential mode, and omitted features. It validates the structure of the local login without
printing it, then presents a separate credential warning and asks for explicit consent before the
copy.

For an unattended setup, the acknowledgement cannot be implied by `--yes`:

```bash
npm run quickstart:aws -- \
  --profile rat-things-sandbox \
  --region us-west-2 \
  --yes \
  --accept-codex-credential-risk
```

Once deployed, send an explicit cloud handoff:

```bash
npm run rat-things -- handoff --thread release-readiness \
  "Draft a release-readiness checklist with rollback steps and return it in your response."
```

## Know what can steal the credential

Secrets Manager protects the canonical AWS copy at rest and lets orchestration pass an ARN instead
of a credential value. Inside the MicroVM, trusted runner code writes `auth.json` with mode `0600`
immediately before starting Codex. The unprivileged Codex process must be able to read the file in
order to authenticate.

That means repository-controlled code running with the same agent UID can also steal it. Rat Things
validates and consumes the current token-bearing fields; it does not promise that every future or
unknown `auth.json` field is absent. Protect the whole object rather than relying on assumptions
about passwords, MFA, cookies, or other fields. A stolen refresh token may enable account
impersonation, subscription consumption, or access to data and connectors visible to Codex.

Use this bridge only when the AWS account, selected repositories, agents, and ChatGPT workspace are
all trusted. Prefer a dedicated account or workspace for shared automation, restrict the runner
role and egress, and maintain a rapid credential-deletion and account-session-revocation procedure.
Read the complete [credential lifecycle](../docs/codex-subscription.md#credential-risk-and-lifecycle).

## Rotate and remove the AWS copy

After signing in again locally or changing accounts, update the quickstart-managed copy without a
full redeploy:

```bash
npm run quickstart:aws -- sync-auth
```

Remove the disposable stack and its managed credential with:

```bash
npm run quickstart:aws -- destroy
```

If you supplied `--codex-auth-secret-arn`, that secret remains operator-managed and teardown does
not delete it. If compromise is suspected, delete the AWS copy first, revoke ChatGPT account
sessions, and sign in again. Deleting only the local file does not invalidate a stolen copy.

## Evidence and limitations

| Evidence field | What is established |
| --- | --- |
| Date | September 1, 2026 |
| Source revision | Working tree based on `818591feeaea5b351364e68808a2566ca55bb025`; not a clean release artifact |
| Environment | Disposable `us-west-2` stack; ARM64 Lambda MicroVM; ChatGPT file bridge |
| Model/provider | Codex using OpenAI models through the copied ChatGPT account session; the retained public record does not name a model ID |
| Scenario | Local file-backed login, authenticated quickstart status check, real Codex draft test, published-revision invocation, and teardown |
| Result | Both Runs succeeded against the same immutable revision; setup through the second Run took 521 seconds; teardown left zero active MicroVMs and an independent Secrets Manager lookup found the managed credential deleted |
| Reproduce | `npm run codex:login`, `npm run codex:status`, then the [AWS-ready quickstart](../docs/quickstart.md) |
| Evidence | [Full authentication validation record](../docs/codex-subscription.md#live-verification-status) |
| Limits | A clean-source published rerun remains outstanding. This is trusted, owner-operated evidence, not proof for untrusted multi-tenancy or a recommendation to prefer account credentials over API keys for general automation. |

## Sources

- [OpenAI Codex authentication and headless login](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex non-interactive authentication guidance](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Rat Things authentication implementation and risk model](../docs/codex-subscription.md)
- [AWS Secrets Manager security best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html)

## Next step

Use the [AWS-ready quickstart](../docs/quickstart.md) for prerequisites, preflight, the exact two-Run
proof, status inspection, and teardown. Choose `--auth bedrock` instead when an AWS-native model and
billing boundary is more appropriate than transferring a ChatGPT login.
