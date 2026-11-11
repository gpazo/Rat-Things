# Shared workspace validation

Contributor evidence. Product usage belongs in `docs/collaboration.md` and
`desktop/README.md`.

## AWS live result

The combined proof passed on one real AWS Session with three independent OIDC
HTTP/SSE clients (Designer, Engineer and QA), Codex, Bedrock
`openai.gpt-5.6-luna`, and Rat Things' Chromium in an ARM64 Lambda MicroVM.
See `live-aws/result.json`, `evidence.json` and `continuation.json`.

- All three collaborators saw and navigated one browser after a Turn ended.
- Point and region comments, replies, unique colors, duplicate submission,
  resolve and reopen propagated to three open streams.
- The agent acknowledged all three attributed nonce-bearing feedback markers
  and read `TEAM-3F1B` from the captured image. That code was absent from the
  feedback text and the browser's extracted page text.
- Reconnect from revision zero replayed five comments and the original capture.
  Viewers could read but could not annotate or navigate; outsiders could not read.
  Revoking QA closed its stream and denied browser access while the others stayed
  connected.

The original harness stalled because it expected uppercase `ENGINEER` while the
agent wrote `Engineer` with the correct nonce. Its failed evidence is retained.
The controller was paused, its five disposable users were reauthenticated, and
the remaining checks completed on the same Session without another model call
or feedback submission. The reusable assertion now permits capitalization while
requiring every marker and the exact visual code; regression coverage rejects
omitted markers and wrong codes.

## Single-scenario observations

These include client and polling overhead; they are not percentiles or load tests.

| Measurement | Observed |
| --- | ---: |
| Session submission | 785 ms |
| Cold Session to browser ready, without inference | 35.710 s |
| Initial prompt submission | 257 ms |
| Prompt to first visible assistant text | 9.797 s |
| Session submission to first Turn completion | 55.615 s |
| Engineer feedback submission | 623 ms |
| QA feedback submission | 262 ms |
| All three annotations visible to everyone | 2.337 s |
| Revocation request through stream closure | 482 ms |

The design submission metric was overwritten by its idempotent retry, so it is
not presented as first-submission latency.

## Fixes and coverage

Cold Chromium image paging exceeded the former ten-second interactive deadline.
Startup now has a separate bounded 90-second budget, checked before model work;
interactive commands retain ten seconds. Browser caches use ephemeral storage,
cache reset preserves the mount directory, early process/pipe failures settle
cleanly, and temporary unavailability returns HTTP 503. Web security and the
Codex sandbox remain enforced. Pi browser ownership persists between Turns;
that adapter was tested without live Pi inference. Team admission stays Codex-only.

Seven browser tests passed, including real headless Chromium and a pipe peer that
delays startup beyond ten seconds. Prior native console checks passed formatting,
Clippy, 53 unit and 24 integration tests, with four opt-in cases ignored. Native UI
screenshots cover a fixture, not three deployed native windows. The JPEGs in
`live-aws/` are actual AWS browser frames, without the native annotation overlay.

After the host restart, the local Linux acceptance proof passed with the real
container worker, browser, Codex protocol and SQLite services. A loopback model
fixture made two requests and no paid inference calls. It verified navigation
and clicking between Turns, attributed and idempotent feedback, and delivery of
the exact captured image to Codex. A graceful service restart preserved the
annotation and capture; its replacement browser opened a fresh generation at
`about:blank`. The local first Turn took 7.078 seconds, including initialization.
See `live-local/evidence.json` and `captured-browser.jpg`.

The local worker exposed a socket ownership bug: setting permissions after
handing the socket to the agent required a capability deliberately absent from
the container. Setting mode 0600 before changing ownership fixed it without
adding capabilities. The local proof includes this final correction; the AWS
proof predates the two-operation reorder. The separate local runtime smoke also
passed command execution as UID 10001, blocked command networking, absence of
host credentials and engine sockets, file access, restart and workspace snapshot.

The final `npm run check` passed: 3,070 tests passed, 83 opt-in tests were skipped,
and architecture, generated API contracts, type checking, Lambda packaging and
bundle smoke checks, site build, formatting and all three Terraform validations
passed. Docker's earlier storage failures recovered after the host restart; no
Docker reset or broad prune was performed. See `checks.json` for the final scope.

This does not establish three native desktop windows, many-user load, local
subscription inference, abrupt recovery, AWS worker replacement, or restoration
of a live browser's navigation state. Full
bundled third-party browser notices still need review before public distribution.
Only the dedicated headless shell was used locally in this pass; full desktop
browser binaries are rejected to avoid reset-to-default prompts.

## Spend and cleanup

Six Session attempts used two inference Sessions; four failed before inference.
Conservative uncached token estimates total **$0.0296461** at the recorded Luna
rates. This excludes infrastructure billing, which has not been attributed, and
is not an AWS invoice. No Astra inference was used. The completed Session used
94,437 input and 1,207 output tokens over four Turns.

The scenario removed its Session, Agent and temporary Cognito users without
cleanup errors. Both diagnostic MicroVMs terminated. After the computer restart,
the exact image-scoped termination check confirmed no active test MicroVMs.
Stack teardown completed and verified zero managed Terraform resources; the
customer-managed KMS key is disabled and pending its required deletion window.
The local proofs also removed their own containers, paired volumes and temporary
profiles. Final teardown verification is recorded in `cleanup.json`.

## Native multiplayer recording

The native capture drives three independent production clients against the local
Linux browser and SQLite services. It covers typing, shared navigation, point and
region annotations, replies, resolve/reopen and captured-image delivery to Codex.
Authentication and model responses are fixtures, explicitly labelled in the
recording. This adds native multiplayer interaction coverage; it is still not an
operating-system window or OIDC-login test.

`demo/multiplayer-workspace.mp4` is the 75-second share edit of that capture. It
omits the resolve/reopen detour and crops a single agent response. The original
walkthrough remains in `demo/source-walkthrough/`. The edit adds captions and
readable comparisons of the three clients, without new deployment or inference.
See `demo/README.md`, `demo/evidence.json` and `demo/checks.json` for the boundaries
and verification records.
