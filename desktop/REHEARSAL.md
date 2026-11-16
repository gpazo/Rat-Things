# Compact actions rehearsal

Applied Stageshow's panel-annotation hierarchy and presence conventions to the
working native console. The deliverable uses the actual Rust widgets, neutral
Rat Things palette, Inter and participant colors. No separate faux application
or production web animation was created.

The panel-annotation gold was filmed before visual inspection. Its still is in
`.codex/pstack-runs/shared-feedback/live/action-ux-gold.png`. The gold film emits
its own framing warnings; no web film gate is claimed for this native interface.

## Decisions

Attachments and saved results are clickable objects. Common secondary actions
use one pinned Phosphor regular family in 30px controls. Tooltips and descriptive
accessible names remain; primary and consequential actions keep short text.
Plan source links show the author and excerpt instead of an appended instruction.
The reply arrow retains its follow-up tooltip and accessible name, matching the
conversation's reply convention. Native tests exercise its actual behavior.

The review found repeated file-version tabs. The tab projection now groups exact
paths, selects the newest saved version by default and preserves a specifically
selected older version. Files retains every version; no saved evidence is removed.

## Rehearsal and review

Inspected actual 1280×850 and 900×650 native views: staged context, a saved source
at 2× zoom, Plan state, source/result links, revision history and Session setup.
The three-client Linux-worker fixture recording exercises typing, image selection,
message delivery, four agent Plan revisions and saved-result retrieval. The
50-second video is in `artifacts/shared-workspace/feedback-demo/`; its agent,
identities and output document are fixtures, and timing is edited.

A separate GPT-6 Luna visual reviewer inspected the gold and the native frames.
Header controls and repeated tabs were refined from that feedback. The final
review confirmed the tab finding resolved and no clipping in the supplied views;
it noted the reply arrow's meaning needs hover clarification, which the existing
tooltip supplies. The static review cannot establish keyboard or screen-reader
behavior.

Verification: Rust formatting/clippy; 80 unit tests; 28 native interaction tests;
a focused Plan retest after file grouping; the opt-in multiplayer recording;
and `npm run check` (3,126 passed, 85 skipped), including packaging, site and
Terraform checks. The normal Rust run retains six opt-in skips. The shared-workspace
recording was separately run with its explicit opt-in.

No new paid provider inference or AWS deployment was used. Native tests use
fixtures. Delegated review used GPT-6 Luna; its token usage and billing total are
unavailable. Local energy cost is unmeasured. Demo workers, paired volumes and
temporary profiles were removed. Full OS accessibility, live-model behavior,
AWS and load/latency were not revalidated by this visual pass.

## Workspace refinement

Pstack's experience-first and prove-it-works guidance shaped this second pass.
Two independent GPT-6 Luna reviewers checked the pictures and interaction code.
The browser now has pinned navigation and a separate, stable annotation/zoom row;
remote keyboard commands live in a compact popover. Active selection has a pressed
state and Escape cancels it, including a pending capture. Fit uses the visible
viewport width; the image scroll surface no longer reserves empty vertical space
and pushes all feedback below the pane.

Plan items open inline through a full-width keyboard-activatable row. Source
quotes use participant-colored names, neutral excerpt text, a border and a
navigation arrow. The reply action retains a short label where an isolated arrow
was ambiguous. Attachments reserve room for removal and truncate long titles.
The original message draft, source version, role checks and agent-owned Plan
states remain intact.

Reviewed fresh native frames at 1280×850 and 900×650, including the real demo page,
keyboard popover, active annotation mode, Plan source/deferred items and history.
The visual reviewer requested a clearer source-link affordance; the refreshed
frame resolved it. The interaction reviewer found no actionable regression in the
focused controls, state, permissions and navigation review. A blank image in an
earlier test screenshot was a synthetic fixture, not missing product content.

All 80 unit and 28 native interaction tests passed. After the final source-link
and image-fit changes, the Plan and captured-context native scenarios passed again,
including the new assertion that feedback remains visible at Fit. Keyboard Plan
toggling, browser text entry at 900×650, selection state and Escape cancellation
are exercised. Formatting and all-target clippy pass. The three-client local
Linux fixture recording passed and its 50-second edit was refreshed.

The first repository-check invocation used macOS's symlinked temporary path;
two unrelated path-sensitive script suites failed. All 41 tests in those suites
passed with TMPDIR=/private/tmp, and the full check passed with that canonical
path: 3,126 passed / 85 skipped, followed by successful packaging, site build and
Terraform validation. The final status is saved with the validation artifacts.

No AWS deployment or paid provider inference was added. The native recording
uses scripted model responses. Delegated model usage/cost and local energy are
unavailable; no total spend is claimed. Full OS accessibility, live-model behavior,
AWS and load/latency remain outside this UI refinement pass.

## Taco collaborator feedback

Used the same panel-annotation gold and Rat Things tokens to refine the actual
native console after the four-agent Taco Cometa simulation. The conversation now
contains long command headings and prose, and an adjustable divider gives the
shared browser more room without hiding chat. Phone/Desktop controls resize the
shared viewport; scroll controls stay visible. Selected modes retain a pressed
state, names and hover explanations.

Reviewed the desktop page, both clients at Phone, the scrolled menu, published
feedback and the reopened phone capture. A final screenshot exposed a stale phone
pin over the resized live page; pins are now restricted to the captured image.
The feedback list remains visible while following the live page. Independent
GPT-6 Luna visual/code reviews were used. The real native two-client scenario
passed, including a saved phone annotation after another user restores Desktop.
The CTA failure was reproduced as a test-driver long press and corrected by using
60 Hz event steps, without changing product click dispatch.

Full evidence, checks, cost limitations and the distinction between fixtures and
live components are in `artifacts/shared-workspace/taco-refinement/REPORT.md`.
No paid provider inference or AWS deployment was performed. Full OS accessibility,
OIDC, live-model feedback behavior and load/latency were not revalidated.


## Completed taco revision loop

Used pstack root-cause and evidence reviews, functional planning at the host-effect
boundary, and stageshow review of the actual Rust UI. The original panel-annotation
gold remains the reference. Phone and Desktop views now identify their shared
size and the most recent host-confirmed collaborator action. Saved captures show
their own dimensions. Local 1:1 review preserves readable page pixels without
resizing the shared browser. Slow explicit actions show a local pending state;
the driver reports their settled errors instead of treating dispatch as success.

Independent Luna visual review covered fitted phone views, 1:1, saved captures,
attributed resize and held requests. No remaining concrete visual issue was found
in those changed cues. Pending attribution was considered and left implicit: it
represents this client's request; named shared attribution records only confirmed
completion. A separate code review found the driver error-reporting gap and
verified the request-ID-based fix.

The two-client native scenario used a real local Linux worker and Chromium with
fixture model responses. The four-teammate follow-up uses one real subscription
Luna Session, with evidence and independent reports under
`artifacts/shared-workspace/taco-completed-review/`. Refer to that report for the
completed revision, review findings, bounds, usage and validation limits.


## Contribution confirmations

Refined the real Rust console against the existing panel-annotation gold. The
local action/result relationship is the focus: Saving becomes Message saved or
Feedback saved only after its own API acknowledgment. Pending and failed requests
preserve drafts. New drafts and Session navigation clear old confirmations.
Resolved feedback has a persistent local confirmation with Show resolved, so the
filter no longer makes success look like a vanished action. Status labels use
AccessKit's polite status semantics; OS screen-reader behavior was not tested.

Held native requests exercise pending, success, failure, retry and retargeting;
wide and 900×650 frames preserve the existing layout. The independent stageshow
review requested naming the recovery action Show resolved, which was adopted.
The code review found no concrete false-success or cross-Session issue. Browser
confirmation scope follows the existing Session-wide browser feedback list;
artifact confirmations match their exact source. One browser remains shared by
all collaborators. Tests and the fresh four-agent run are recorded under
`artifacts/shared-workspace/taco-confirmations/`.

The fresh local rerun completed draft → captured phone-header feedback → revised
website → designer resolution → four final reviews. The designer independently
used Feedback saved, Feedback resolved and Show resolved; no duplicated
contribution or resolution occurred. A persistent generic timeout notice still
confused reviewers, and two questioned whether Message saved meant draft autosave
after time had passed. Keep those residual findings visible in the evidence.
The full repository check and native check passed; the final polling-priority
change also passed its held-resolution test and final clippy/format checks. The
report distinguishes deterministic fixture frames from the actual live clients,
records subscription usage and validation limits, and confirms resource cleanup.

## Read recovery and sent receipts

The next pass keeps the existing composer and progress-row geometry. Read errors
now belong to their list, details, credentials or activity stream. The activity
row says Updates paused · Reconnecting while data and drafts remain visible;
successful recovery restores ordinary progress without an overlay. Sending and
Last message sent / Last feedback sent describe submission, not draft autosave or
agent acknowledgment. Last send not confirmed names the attempted action when a
response is lost or rejected. User-facing documentation explains checking chat
before retrying an uncertain submission.

The stageshow review accepted the wide and 900×650 read-recovery frames and the
new sent receipts. It requested making failure wording explicitly refer to the
attempted send; Last send not confirmed was adopted. The gold remains the prior
panel-annotation reference, with the real application's components and typography.
No faux UI or added layout surface was introduced. Code review checked current
generation fencing, SSE recovery, and preservation of unrelated mutation errors.
Held HTTP tests and the fresh four-client run are recorded separately under
`artifacts/shared-workspace/taco-status-recovery/`; OS accessibility and broad load
behavior remain outside this pass.
