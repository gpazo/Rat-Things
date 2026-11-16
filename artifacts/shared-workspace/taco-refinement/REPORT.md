# Taco multiplayer feedback: fixes and verification

The four teammates' review led to changes in the native console and the shared
browser. The original [simulation report](../taco-team-simulation/REPORT.md) and
independent participant reports remain unchanged. This pass uses deterministic
fixtures to reproduce the problems; it is not a second autonomous four-agent run.

## What changed

| Feedback | Change | Evidence |
| --- | --- | --- |
| Conversation runs behind the workspace | Long command headings truncate within their pane, retain their full hover/detail content, and normal messages wrap. Both panes enforce their clip boundaries. | [Before](before-layout.png), [after](conversation-contained.png) |
| Phone review is unavailable | Phone (390×844) and Desktop (1280×800) resize the one shared browser. The agent can request bounded dimensions with the same resize action. | [First client](phone-first.png), [second client](phone-second.png) |
| Scrolling and navigation are hard to discover | Scroll up/down is in the pinned toolbar; remote typing stays in its keyboard popover. Background frame reads no longer disable actions. Selected modes have a visible pressed state. | [Phone menu](phone-menu.png) |
| More preview room hides the discussion | The workspace uses the window width and has a draggable, keyboard-accessible divider. Expansion and narrow-window tabs remain available. | [Resized panes](resizable-workspace.png) |
| The menu CTA did not appear to work | The native test driver used 250 ms animation steps, turning its multi-step click into a long press. At 60 Hz the actual native click navigates and the other client sees the same URL. No browser click workaround was added. | Real Chromium regression and two-client native test |

The final screenshot review also found a stale annotation pin painted over a
resized live page. Pins now appear only on the capture being viewed. Feedback
remains listed in the live view, and its source action opens the original image.
[Live desktop with feedback](feedback.png) and [original phone capture](saved-phone-capture.png).

## Behavior decisions

- Viewport and page scrolling are shared operations. Image zoom and the pane
  divider are local presentation choices. Phone means a CSS viewport size; it
  does not emulate a mobile OS, touch input or user agent.
- Resize uses the existing permissions, operation receipts and epoch/revision
  fencing. It does not widen Session capabilities. Competing stale actions are
  rejected; duplicate operations remain idempotent.
- Published feedback stays attached to an immutable capture, including its
  dimensions. Resizing or navigating does not relocate the original annotation.
- Pure functions calculate viewport-dependent capture coordinates, pane widths
  and capture visibility. Network, Chromium and UI mutations stay at their
  existing effect boundaries; no functional-programming framework was added.

## Verification

The focused local acceptance runs two instances of production ConsoleApp against
the real local Session service, SQLite, an isolated ARM64 Linux worker and Chromium.
It switches both clients to Phone, clicks the menu link through the native preview,
checks shared navigation, scrolls, drafts feedback, restores Desktop from the
second client, publishes feedback, and reopens the original phone capture while
asserting that the live browser remains Desktop. [Machine evidence](evidence.json),
[activity](activity.json), [cleanup](cleanup.json).

Authentication uses loopback fixture identities. Agent responses are deterministic
fixtures, so the conversation text is seeded demo content rather than a new taco
planning conversation. This tests real transport, storage, browser and native
interaction; it does not establish how a real model responds to feedback.

- Repository checks: 3,126 tests passed, 86 opt-in tests skipped; architecture,
  schema, generated worker, typechecking, packaging, site and formatting passed.
  The single `npm run check` invocation stopped at Terraform because PATH selected
  system Terraform 1.5.7. All three remaining Terraform validation stages then
  passed with installed Terraform 1.16.6. No infrastructure was deployed.
- Real Chromium suite: 9 tests passed, including resize dimensions, normalized
  post-resize clicks, idempotency, stale actions and immutable captures.
- Final native checks: formatting/clippy, 81 unit tests and 29 interaction tests.
  The two-client local browser acceptance passed separately with its opt-in.
  Eight opt-in native tests are skipped in the ordinary suite; the two-client
  scenario is the one explicitly rerun in this pass. Logs: [native acceptance](live-native.log),
  [Chromium](browser-final.log), [console](console-check-final.log), [Terraform](terraform.log).

Pstack's root-cause and prove-it-works guidance informed the reproductions.
Independent GPT-6 Luna code and visual reviews inspected the changes and rendered
views. A final focused review found no concrete issue in capture pin visibility
or pending frame fencing. A code reviewer raised a possible maximum-size JPEG overflow. A real
1920×1440 seeded high-entropy canvas produced 1,781,116 base64 bytes against the
3,145,728-byte limit ([measurement](frame-envelope.json)); the overflow was not
reproduced. This is one bounded stress fixture, not a guarantee for every page.
No speculative frame-recovery mechanism was added.

Stageshow's panel-annotation and presence guidance was applied to actual Rust
widgets, preserving the existing palette and icon family. Review frames show the
real Taco Cometa artifact. No faux UI or replacement product mockup was created.

## Limits and costs

No AWS deployment, paid inference, new subscription-backed model run, four-agent
usability rerun, OIDC login, OS accessibility review, load test or latency benchmark
was performed in this pass. Existing permission regressions ran, but a new live
read-only/revoked-user scenario was not added. Phone layout validation covers this
fixture and does not claim full mobile-browser compatibility.

Paid API inference calls: 0. New AWS resources: 0. Delegation used GPT-6 Luna;
delegated token usage/billing and local energy cost are unavailable, so this is
not a total-cost estimate. Task-owned worker, volumes and temporary profile were
removed; build caches and the existing signed-in profile were retained.

Earlier diagnostic captures are retained under `diagnostics/`; they describe
failed intermediate test-driver runs, not the final outcome.
