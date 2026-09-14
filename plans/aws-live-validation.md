# Live AWS acceptance cycle

Historical acceptance: live API, managed worker, console, webhook, five-minute
transport and maximum file transfer cases passed on the candidate below. Later
rollouts are recorded in [`agents-api-audit-2026-09-13.md`](agents-api-audit-2026-09-13.md).
The original soak failed its second SSE completion assertion, and cleanup stopped
before Terraform on an AWS signature-expiry error. The state-owning ARM64 machine
recovered both completed Turns and hash-verified artifacts proving the same process
survived 29,395 seconds. The Session is deleted and its runtime closed. This is
process-continuity evidence, not a complete soak pass. State reconciliation,
current images and follow-up results are in
[`aws-live-resume-2026-09-14.md`](aws-live-resume-2026-09-14.md).

- Deployment: `ag260913a`, account `731841023867`, region `us-west-2`.
- Endpoint: `https://agents-ag260913a.dev.indubitably.ai/v1`.
- Backend: dedicated ARM64 EC2 workers; MicroVM provisioning disabled.
- Model: `openai.gpt-5.6-terra`, confirmed visible through the worker's Bedrock
  Mantle model-catalogue endpoint with the current AWS identity.
- Input, state, plans and logs: `.aws-e2e/ag260913a/` (ignored, preserve for recovery).
- Worker and relay images are published under deployment-owned ECR repositories.
  The original digests match `agents-api-validation.md`; live fixes use worker
  `sha256:70cf49c50a7ba144acb3a95d281dc4bc659cef2bdc870cbb5866cf9116b001d8`
  and HTTP/relay
  `sha256:cbe9ef8fbfe4e473b63b171d715c5e4d6fb47661e758dc0941ef2130db611a28`.
  The pinned native Codex package and patches are unchanged.
- The certificate is issued. Only this hostname's A alias and validation CNAME
  were created in the authoritative `indubitably.ai` zone. The existing `dev` zone
  is not delegated; its temporary validation record was removed. Broader DNS
  delegation was not changed.
- The reviewed plan creates 308 resources, changes/deletes none, and provisions
  one EC2 launch template with no MicroVM resources.

## Findings

Live evidence is retained under `.aws-e2e/ag260913a/`:

| Case | Result | Artifact |
| --- | --- | --- |
| Discovery, IAM-issued API authentication, anonymous denial, binary Files, two saved model Turns and deletion | Passed | `api-live-2.log` |
| Managed workspace, retained command process across Turns, artifacts, SSE, idempotency, UID 10001, metadata/lifecycle/config isolation | Passed | `managed-live.log` |
| Same managed proof on final token-file/readiness deployment | Passed in 132 seconds | `managed-ready-live.log` |
| Console creates, continues and reloads two real model Turns | Passed | `console-live-3.log` |
| Committed Session event reaches our HTTPS webhook capture | Passed | `webhook-live-2.log` |
| Five-minute disconnected-environment deadline returns 408 while SSE stays open | Passed on original and revised clients | `http-live-3.log` (second case) |
| 8 MiB binary transfer with the revised HTTP client | Passed | `http-8mib.log` |
| 512 MiB binary transfer | Passed checksum, byte count and deletion on revised client | `http-live-3.log` |

The initial continuation failure came from private message ordering fields leaking
into the runner's strict API validator. Execution now projects only role/content.
Session deletion closes the harness without requiring a successful per-Turn RPC,
and closed runtime authority cannot be reopened by an old receipt. The failed
proof's Session and Agent were deleted successfully after the fix.

Cold managed harness admission used the ordinary six-minute SQS visibility delay.
Expected cold-worker and disconnected-environment retries now use five seconds.
The console accepts port zero for an OS-assigned listener; its live test selects
the explicit creation control on the empty-state screen.

Long-lived EC2 Sessions now have a candidate host-managed rotating bearer-token
file and native Codex command authentication. AWS credentials remain host-only.
Local rotation/failure tests and native expired-token recovery passed. The updated
ARM64 worker passed isolation/browser canaries; its 153 strict Linux fixtures
passed, including native Bedrock command auth. Live rollout passed; long soak remains.
The final worker uses protected host `/tmp` rather than guest `TMPDIR`. A root/UID
10001 container probe verified that the guest can read the scoped token but cannot
write it or rename its parent directory. The subsequent refreshed-worker canary
exposed a second readiness race: private Run heartbeats precede native control
initialization. Dispatch now reads the control bridge's readiness before
submitting a new Turn, using the short 503 retry while it initializes. The timed-out
canary cleaned up its Session. The final repository check passed with 831 tests
and 11 opt-in skips (`native-readiness-check.log`). The fresh live canary passed
in 132 seconds (`managed-ready-live.log`).

The first real plan exposed missing `agents-api` and `agents-outbox` package-path
exports in the AWS harness. The overrides now point at repository `dist/` from
`testing/aws`. The corrected plan and full repository check passed before apply.

A separate optional live webhook case uses the existing deployment-owned capture
queue to verify committed Session events reach an HTTPS receiver through the
outbox. It does not contact a real provider account or invoke a model. That fixture
captures bodies only; signature integrity remains covered by local SDK checks.

## Required execution

1. Complete the 29,100-second managed process soak on the final worker.
2. Record actual results and remaining conformance rows, then remove this cycle's
   Sessions, workers, stack and bootstrap ECR/DNS/certificate resources.

The ignored `run-soak-and-cleanup.sh` wrapper records `soak-status.json` and
`soak-live.log`, then attempts teardown whether the test passes or fails. The
bootstrap cleanup is limited to this cycle's exact DNS records, certificate and
ECR repositories. `soak-teardown.log` records cleanup outcome. The local supervisor
uses `caffeinate -i` while this bounded run is active. Broader conformance rows and
retired-production-data disposition remain separate work.

The soak started at `2026-09-13T23:13:11Z`. Its Session is
`sess_a3cf9b41996b45898cf3536ccc9729c6`; first Turn
`turn_b966e063c74e449dbda9bf00b2e3e79c` is completed. The observed public state is
saved in `soak-observed-start.json`. A completed first Turn does not prove long
process continuity or credential renewal; those assertions remain pending.

Keep `.aws-e2e/oauth260827a`, unrelated infrastructure and credentials intact.
Bootstrap resources are recorded in `bootstrap-resources.json`; the ordinary
Terraform teardown does not own those ECR repositories, DNS records or certificate.
