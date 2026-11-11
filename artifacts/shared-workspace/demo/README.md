# Works on our machines

A 75-second, sound-off demo of a designer, engineer and QA collaborator working
with one agent in one shared Rat Things Session.

**Watch:** [multiplayer-workspace.mp4](multiplayer-workspace.mp4)

**Captions:** [multiplayer-workspace.srt](multiplayer-workspace.srt)

**Cover:** [poster.png](poster.png)

## What the team is doing

The team is planning a bug-report product around “it works on my machine.”
The page in the browser is their concept under review. Maya challenges the framing,
Eli limits the first release, and Sam raises an offline edge case. These are
contributions to the product direction, not separate agents or claims that the
concept has been implemented.

## How collaboration works

1. **Open the same Session.** Each collaborator uses their own client and identity.
   Participant names and colors identify who contributed; remote typing shows
   when someone is composing a message.
2. **Work in one live browser.** A navigation or click changes the browser the team
   is viewing. In the demo, Eli clicks “Review together,” and all three clients
   show the updated page.
3. **Capture the evidence.** Adding feedback captures the current page. A pin or
   region refers to that version, so its context survives later navigation.
   “Return to live view” takes the collaborator back to the current browser.
4. **Discuss the same annotation.** Eli replies to Maya’s note; Sam creates a
   region comment. Everyone can see the authors and discussion in their own client.
5. **Keep the same agent in the conversation.** Sharing feedback supplies the
   captured image and attributed comments to the Session’s agent. The discussion
   becomes context for its next response.

The demo gives all three people the collaborator role. Access still follows the
space’s roles; the video does not demonstrate sign-in or permission changes.

## Scenes

| Time | What to watch |
| --- | --- |
| 0:00 | The team and their brief |
| 0:07 | Maya drafts; Eli and Sam see her typing |
| 0:13 | Eli interacts with the shared browser |
| 0:20 | The updated page in three independent clients |
| 0:24 | A capture preserves the version being reviewed |
| 0:29 | Maya pins design feedback |
| 0:35 | Eli replies with an implementation constraint |
| 0:43 | Sam selects a region and raises an edge case |
| 0:51 | The same discussion in all three clients |
| 0:56 | One agent receives the shared context |
| 1:10 | The shared workspace and takeaway |

## Suggested sharing copy

> “It works on my machine” becomes a shared investigation. A designer, engineer
> and QA collaborator review one browser, annotate the same captured page and
> give feedback to one agent in one Rat Things Session.
>
> This is a real local collaboration capture with demo identities and scripted
> agent replies.

## What is real in this recording

The native console, HTTP requests, activity streams, Session orchestration,
SQLite, Codex protocol, isolated Linux worker, Chromium, captured images and
attributed feedback are real. Three authenticated loopback identities and the
agent’s Responses-model replies are fixtures. This is not an OIDC login, live
inference, subscription-auth or AWS deployment recording.

The agent excerpt illustrates how shared feedback enters the continuing
conversation; the words are scripted, not an evaluation of model reasoning.
Delivery of a captured JPEG into the provider request was checked by the source
capture harness and recorded in [evidence.json](evidence.json). It is not directly
visible in the conversation excerpt.

This edit uses only crops, cuts and holds of the original native renders. It
does not repaint UI text or synthesize app states. Idle navigation and the
resolve/reopen detour are omitted. The final excerpt shows the first existing
summary; the original fixture repeated that summary for subsequent status
events. The complete original walkthrough remains in
[source-walkthrough/multiplayer-workspace.mp4](source-walkthrough/multiplayer-workspace.mp4).

Timing is edited for comprehension and is not a latency measurement. No new
inference or deployment was required to produce this edit. The original local
capture used no paid model calls and removed its temporary worker resources.

## Reproduce or review

The contributor instructions are in
[testing/shared-workspace/README.md](../../../testing/shared-workspace/README.md).
The declarative edit specifies every source range, crop and hold. Exported
[recording.json](recording.json) includes shot times and source-image hashes.
[review/storyboard.jpg](review/storyboard.jpg) shows the final shot states;
[review/review.md](review/review.md) records editorial review and its limits.
