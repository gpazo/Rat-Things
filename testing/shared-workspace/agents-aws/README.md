# Local first, then shared: live AWS proof

`controller.ts` checks the local-first collaboration flow against a disposable
AWS stack. Claude starts a Session alone on this Mac using the ChatGPT
subscription, signs in to the team through the real Cognito hosted page, and
Shares the Session. Claude then creates a single-use invite link. Codex joins
through the desktop's own join path (`ConsoleTeams` `/join`: parse the link,
sign in, redeem). The controller checks that:

- Codex is refused before joining;
- Codex joins as a collaborator;
- the spent link is refused;
- no invites remain open.

The Session uses `environment: none`, so neither the Mac nor AWS starts a Linux
workspace. Docker is not required.

The controller then starts a loopback relay. The relay holds both verified
sign-ins in memory and writes `agents-live.json` in its private directory, so the
[`agents-live`](../agents-live/README.md) participant client and native recorder
work unchanged. Set `RAT_THINGS_LOCAL_DIR` to the relay directory that the
controller prints. Bearer tokens and passwords never leave the controller.

## Run

Deploy a stack with shared Sessions and the inexpensive model. The controller
rejects any other model:

```sh
AWS_E2E_SHARED_SESSIONS=true AWS_E2E_REAL_CODEX=true AWS_E2E_ENABLE_MICROVM=true \
  AWS_E2E_CODEX_MODEL_ID=openai.gpt-5.6-luna npm run aws:e2e:deploy -- DEPLOYMENT_ID
set -a; source .aws-e2e/DEPLOYMENT_ID/runtime.env; set +a
```

`AGENTS_AWS_INVITE_ONLY=true` checks team sign-in and invite links without the
local Turn, Share, or any model call. It also checks that a collaborator cannot
create invites and that a revoked link is refused, then exits.

For the full flow, sign the demo profile in to the ChatGPT subscription and keep
stdin open. Closing stdin stops the relay and deletes the hosted Session and Agent.
It also removes the temporary Cognito users, saved sign-ins and the relay directory:

```sh
sleep 7200 | CODEX_BINARY=$PWD/node_modules/.bin/codex AGENTS_AWS_LIVE=true \
  node --import tsx testing/shared-workspace/agents-aws/controller.ts
```

The relay returns `429` once there have been `AGENTS_AWS_MAX_HOSTED_TURNS` hosted
Turns (default 4), or once the estimated hosted inference reaches $1. The
controller stops after `AGENTS_AWS_MAX_MINUTES` (default 75). Evidence goes to
`artifacts/shared-workspace/agents-aws/evidence.json`. It records:

- each step with its timing;
- local and hosted token usage;
- a list-price inference estimate;
- cleanup results.

Infrastructure billing is not included. Always run
`npm run aws:e2e:destroy -- DEPLOYMENT_ID` afterwards.

History carried by Share is shown as imported. Its author is not a verified team
identity, so clients label it as a participant rather than by name.
