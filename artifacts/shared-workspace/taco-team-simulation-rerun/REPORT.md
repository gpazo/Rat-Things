# Four-agent Taco Cometa rerun

Four independent simulated teammates built and reviewed a fresh restaurant website
through Rat Things. All four initial contributions reached one active coding Turn.
They used the shared desktop/phone browser, checked navigation, and published a
captured design annotation. The requested typography revision started but did not
complete before the configured observed-token ceiling stopped the test.

[Open the completed first draft](index.html). [Published feedback](screenshots/published-feedback.png).
[Machine verification](verification.json). The exported website is the first draft,
not an unverified revision.

## Setup and outcome

Alex (client lead), Maya (designer), Eli (engineer), and Sam (QA) were separate
GPT-6 Luna collaborator agents. They operated four production ConsoleApp clients
through the native event bridge. One GPT-6 Luna coding agent ran locally through
the existing ChatGPT subscription, using real Session services, SQLite, the Linux
worker, Chromium, artifacts and Plan tools. No participant edited the website
outside the software. Their messages and the website were not pre-scripted.

Four native clients stayed connected; collaborator reasoning ran in bounded waves
because three child-agent slots are available. Authentication used fixture loopback
identities, not OIDC. This was headless native interaction, not four OS windows or
a human usability study. After independent initial reviews, the operator clarified
that the bridge returns immediately after dispatch: reviewers separately rechecked
async navigation and source loading. Original reports remain unchanged alongside
those follow-ups.

The agent built a self-contained, 15,050-byte site with a food illustration, hero,
sample menu/prices, and fictional visit details. The first Turn completed in 166
seconds, approximately 167 seconds after input acceptance. These are one-run
measurements excluding provisioning, not latency percentiles. Source inspection
found no external URLs, scripts or forms; no network-capture test was performed.

Five attributed input receipts were dispatched: four initial contributions and
one published annotation. The first four share the same Turn. All four identities
have distinct colors. Plan revision 1 links to all four initial source receipts and
the saved artifact hash. The annotation retains its capture identity, version and
region, and its text reached the second Turn. We did not separately prove that the
model interpreted its image correctly.

## What each teammate found

| Teammate | Contribution and observed result | Feedback and limits |
| --- | --- | --- |
| [Alex — client](reports/client-final.md) | Defined the visitor goal, sample menu and honest visit information; reviewed hero, menu and Plan. | Liked the clear food/visit paths. Did not independently reach the Visit details; their proposed labeling check was already satisfied in Eli's and Sam's views. |
| [Maya — designer](reports/designer-final.md) | Proposed clear menu hierarchy, then captured and published a region annotation asking for larger mobile label/description text. | Found small text in the fitted preview. Annotation appeared in chat and the feedback list, and the agent acknowledged it. The revision was not reviewed. |
| [Eli — engineer](reports/engineer-final.md) | Kept the site static and truthful; exercised Menu/Visit, checked sample details, and opened HTML source. | Initially mistook the source-loading gap for an empty artifact. Source appeared after settling. Another participant changed viewport during review, so the first tap was not phone-specific evidence. |
| [Sam — QA](reports/qa-final.md) | Requested phone anchor and long-name/price checks; completed them in a separate assisted recheck. | Both headings appeared below the sticky header; the long name wrapped with its price visible. Immediate action screenshots were inconclusive until navigation settled. |

Their independent ratings were 4/5 for clarity, 4–5/5 for collaboration and 3/5 for
artifact review. These mix website and tool impressions and are qualitative
observations, not a benchmark. Final revision review was unavailable to everyone.

## What improved since the first simulation

- Phone sizing is real and shared. The agent used resize and collaborators used
  the Phone/Desktop controls. [Phone menu](screenshots/phone-menu.png) and
  [phone visit](screenshots/phone-visit.png) show the resulting layout.
- Menu and Visit navigation work at phone width after the async action settles.
  The earlier pointer-only interpretation was an observation-timing error.
- Scrolling was available in the toolbar. No reviewer reported conversation text
  crossing into the workspace in these captures; long command headings stayed
  contained. This is observational coverage, not a stress test of every string.
- A participant published actual captured feedback, which the agent received.
  The first simulation had stopped at an unsent draft.
- HTML source loaded through its artifact tab. A blank immediate screenshot did
  not mean the artifact was missing. [Loading](screenshots/source-loading.png),
  [settled source](screenshots/source-loaded.png).

## Priorities revealed by the run

1. **Keep Plan status faithful to individual feedback.** The agent grouped all
   four contributions into one addressed item while its reason explicitly said
   the phone tap check was unfinished. The later QA recheck passed, but the Plan
   did not yet represent that evidence. Separate requirements/checks and preserve
   outstanding verification rather than marking the whole bundle addressed.
2. **Make shared navigation easier to attribute.** Reviewers lost track of whether
   they were seeing Phone or Desktop when someone else resized the browser. Keep
   one shared browser, but make the current viewport and recent actor/action clear.
   Captured feedback already gives reviewers a stable source to discuss.
3. **Distinguish dispatch from completion in the test bridge.** It returns an
   immediate screenshot while navigation or source loading is pending. Add an
   explicit pending result or a bounded wait for the requested outcome. Assess the
   remaining human-facing loading UX separately; do not count these screenshots
   as proof of persistent product failure.
4. **Make the agent's browser contract harder to misuse.** It sent pixel positions
   `(170,32)` and `(170,65)` to an API requiring normalized coordinates. Both were
   rejected. Explicit field ranges, descriptions and actionable validation errors
   would avoid retries and unresolved checks. Native normalized clicks succeeded.
5. **Separate preview scale from website legibility.** A 390px phone viewport is
   fitted into a smaller on-screen image. Make 1:1 inspection easy before changing
   page typography based on the scaled preview. Maya's suggestion remains a
   legitimate design request, but its completed effect was not measured here.

The harness also needs a better end-of-budget workflow: stop new inference while
keeping a read-only review surface and exporting evidence before shutdown. This
run's deliberate server cleanup made the final clients show an unavailable signer
and no sessions. That disconnect was induced by the test harness, not a spontaneous
multiplayer outage. The reviewers' final reports describe the visible consequence;
this is the operator's explanation of its cause.

## Budget, interruption and cleanup

The bound was six Turns, 400,000 observed tokens, sixty tool Items and 25 minutes.
The first Turn reported 311,523 tokens. During the second Turn, the total reached
403,462 and the polling monitor closed the server and worker. The small overshoot
reflects usage arriving after a request completes; this is an observational bound,
not a provider-enforced token reservation.

At shutdown the second Turn was still in progress. It had read the stylesheet
(after falling back from unavailable `rg` to `grep`); no revised artifact or Plan
revision was exported. We did not restart inference or increase the ceiling.
The cleanup snapshot retains that in-progress status rather than claiming a
completed or fully settled revision.

Last reported coding usage: 394,367 input tokens, including 348,544 cached input
tokens, and 9,095 output tokens. Model/provider: GPT-6 Luna through Codex/ChatGPT
subscription. No paid model API or AWS resource was used. Subscription per-run
monetary cost, delegated model usage/billing and local machine cost are unavailable;
this is not a total-cost estimate or provider billing reconciliation.

All four native drivers exited successfully. The fifty UI commands had one returned
action error: reopening a Session after quota cleanup made it unavailable. An action
returning success only confirms dispatch; settled outcomes are supported by the
follow-up evidence. Worker, paired volumes, loopback server and private connection
file were removed. The existing signed-in profile and build caches remain.
[Cleanup evidence](cleanup.json), [native action log](native-actions.json).

No product code was changed during this rerun. AWS, OIDC, permissions/revocation,
reconnect/recovery, full accessibility, load/concurrency limits and the completed
feedback-to-revision loop were not validated. The earlier automated regression
results were not rerun merely to generate new counts.

## Evidence

- [Phone hero](screenshots/phone-hero.png), [desktop menu](screenshots/desktop-menu.png)
- [Phone menu](screenshots/phone-menu.png), [phone visit](screenshots/phone-visit.png)
- [Captured draft](screenshots/captured-feedback-draft.png), [published feedback](screenshots/published-feedback.png)
- [Plan](screenshots/plan.png), [source](screenshots/source-loaded.png)
- [First-draft activity](first-draft-activity.json), [shutdown activity](activity.json)
- [QA settled recheck](reports/qa-followup.md), [engineer settled recheck](reports/engineer-followup.md)
- [Run configuration and source hashes](run-config.json)
