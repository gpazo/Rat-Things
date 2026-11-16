# Taco Cometa: four collaborators, one shared agent

The team produced a self-contained restaurant website through Rat Things. All four
participants' contributions reached the same active Turn. The agent published a
Plan with three requirements addressed and the requested mobile review explicitly
deferred. The experiment exposed concrete review friction; it does not establish
that the multiplayer workflow is ready for arbitrary teams or loads.

[Open the generated website](index.html). [Activity and receipts](activity.json).
[Cleanup and model usage](cleanup.json).

## What was real

Four independent GPT-6 Luna collaborator agents used production `ConsoleApp`
controls through four separate headless native clients. Alex represented the
client, Maya design, Eli engineering and Sam QA. Their messages and the website
were not pre-scripted. One real local GPT-6 Luna coding agent used the existing
ChatGPT subscription, production Session services, SQLite, the isolated Linux
worker, shared browser, artifacts and Plan.

The four clients were connected during the build. Collaborator reasoning ran in
bounded waves because the host supports three child agents at once. Authentication
used fixture loopback identities with the collaborator role; this was not an OIDC
sign-in exercise or OS-window automation. Each participant reviewed the result and
wrote an independent report before the operator's follow-up checks.

## Contributions and feedback

| Teammate | Contribution in the product | Independent experience |
| --- | --- | --- |
| Alex, client lead | Menu, vegetarian options, sample prices, prominent fictional visit details; no checkout or deployment | Recognizable restaurant and useful Plan. Could not confidently inspect the lower page; conversation was obscured in split view. |
| Maya, designer | Explicit vegetarian labels and sample labels beside fictional details | Cohesive visual hierarchy. Expanded preview helped; default split preview was too small for reliable review. |
| Eli, engineer | Offline-safe assets and informational actions, with no forms or data capture | Plan connected requirements to source messages and the output. Artifact opening hit a test-driver failure; network behavior remained unverified. |
| Sam, QA | A visual check around 390 px, including menu scanability and visit information | Saw the missing mobile check recorded as deferred. Created and removed an annotation draft through the ordinary composer; did not publish it. |

Original reports, preserved without retrospective editing: [client](reports/client.md),
[designer](reports/designer.md), [engineer](reports/engineer.md), [QA](reports/qa.md).
Some reports describe controls as unavailable. The corrections below distinguish
their initial experience from the operator's later checks.

## Verified outcome

- Four durable, attributed input receipts, all dispatched to one completed Turn;
  no pending inputs. The three follow-up contributions arrived while it was active.
- Plan revision 1, three items addressed and one deferred. All six source
  references match their input receipt/message pair. All four result links match
  the exported artifact and its SHA-256 version.
- The generated HTML is 9,662 bytes. SHA-256:
  `3ea7fe08d2568a1e1bc0af2b362b5cced1997c8937712580f321b6425cbdad89`.
- The operator scrolled the shared browser through the menu and visit section.
  Sample prices, two vegetarian labels and sample-marked address, hours and contact
  were visible. Static source inspection found inline CSS, anchor links, and no
  scripts, forms or remote resource URLs. This was not a network-capture test.
- The Turn took 165 seconds from recorded start to completion, or about 167 seconds
  from first input acceptance. These are one-run observations excluding Session
  provisioning, not latency percentiles or load measurements.
- Eight tool-call Items: three commands, four browser calls and one Plan update.
  The first browser call failed its frame-freshness requirement; the agent recovered
  with a snapshot. No Turn failure was recorded.

## Improvements to prioritize

1. **Fix conversation layout containment.** Long conversation/tool text crosses
   the split-pane boundary or gets clipped. This is visible in both an original
   participant capture and the operator's source-tab recheck. Wrap or contain long
   lines and preserve a usable minimum conversation width. Verify with long commands,
   normal prose and narrow windows before another usability run.
2. **Add shared browser viewport presets.** Neither participants nor the agent
   could set the page to 390 px. Expanding/resizing the console only changes how a
   1280 px browser image is displayed. Expose phone/desktop dimensions to both the
   agent and collaborators, preserving the common page and existing authority.
3. **Make browser interaction easier to discover and verify.** Scroll controls do
   exist under the keyboard-shaped Browser controls menu, and the operator used
   them successfully. The initial driver briefing emphasized annotation clicks and
   contributed to confusion; the reports are not evidence that scrolling is absent.
   A later direct click on “Explore the menu” did not produce a visible navigation
   in the captured frame. That outcome remains unresolved and needs a focused
   reproduction before declaring ordinary page interaction fully validated.
4. **Improve review space without losing the conversation.** Expanding the preview
   helped all reviewers, but hides the discussion. Consider a resizable divider and
   a persistent compact conversation/Plan rail. Test whether teammates can inspect
   detail and keep track of new contributions without repeatedly switching views.

The Plan was the strongest part of feedback follow-through: Eli could open the QA
requirement and return to Sam's actual message. The agent did not falsely mark the
mobile review complete. Keep that traceability as the review surface improves.

## Test-driver correction

Opening `index.html` terminated the engineer's first driver because
`egui_kittest` defaults to panicking on missing glyphs, including the generated
`✦` character. Production egui uses a missing-character box. The bridge now uses
that production fallback. A restarted engineer client opened the artifact
successfully. This was not evidence of a production app crash. The original failed
driver and the later successful recheck are distinct runs.

## Evidence

- [Shared website in the console](screenshots/website-hero.png)
- [Menu after scrolling](screenshots/website-menu.png)
- [Sample visit details](screenshots/website-visit.png)
- [Plan](screenshots/plan.png) and [source message](screenshots/plan-source.png)
- [Conversation clipping](screenshots/conversation-clipping.png)
- [Annotation draft](screenshots/annotation-draft.png)
- [Source tab with production font fallback](screenshots/source-fallback.png)
- [Unconfirmed menu-click result](screenshots/menu-click-unconfirmed.png)

## Scope, cost and cleanup

One subscription-backed Turn reported 217,892 input tokens (179,072 cached) and
8,092 output tokens: 225,984 total. The collaborator model was also GPT-6 Luna.
Delegated token/billing telemetry and subscription per-run monetary cost are
unavailable. Paid API inference and AWS resources were not used; API/AWS spend for
this exercise was $0. That is not a total-cost estimate: subscription allocation,
delegation and local machine costs are unmeasured.

The run stayed within its ten-Turn, 400,000 observed-token, 60-tool-Item and
25-minute bounds. Only four work contributions were submitted. No teammate found
a concrete website correction to send in the second review round, so the exercise
did not test a sustained disagreement/revision cycle. Published annotation delivery,
mobile rendering, OIDC, read-only/revoked users, reconnect/recovery, accessibility,
AWS and load/latency percentiles were not validated here.

`npm run check` passed: 3,126 tests passed, 85 skipped, with packaging, architecture
and Terraform validation. Rust formatting and clippy passed. Three original native
clients and the restarted engineer client exited successfully; the original
engineer driver failed as described above.

All task-owned native clients, the loopback server and local worker stopped. Both
worker volumes and the private connection file were removed. The existing local
profile and sign-in were preserved. No production product fix was made as part of
the simulation; changes are confined to the test harness and evidence.
