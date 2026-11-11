# Rehearsal: Session conversation

Gold: stageshow `ai-chat`, copied and filmed before this study. Retained its
Collapse/Stream relationship between a submitted message and the agent's reply.
Replaced its identity and content with Rat Things tokens, Inter, the real mark,
and the shared workspace's participant colors. Compared with the gold, this
study gives more space to authorship and the original quoted message.

Beats: reply to Eli → type Sam's feedback → submit it → the agent incorporates
the shared discussion → hold the outcome. Plays once. The exported clip lasts
16 seconds; Replay explicitly starts again. Reduced motion shows the outcome.

Captured: dark desktop 960×620, compact 358×600 in a 390px viewport, reduced-motion
posters, wide and compact flow sheets, marked states, and eight samples around
each of reply, compose, send, answer and completion. Beat samples have a 40ms
wait between screenshots; capture overhead adds to that interval. Browser:
dedicated headless Chromium on macOS ARM64. No personal browser profile was used.

## Corrections

- Removed the prototype sidebar from this close-up; conversation and its toolbar
  are the subject. Native setup navigation remains in place.
- Tightened author/body spacing and shortened the stage to remove excess empty
  space. The history is a semantic section containing message articles of
  different heights, rather than a uniform list; the long quoted message must
  not be mistaken for an empty gap between short rows.
- Constrained prose width and sized the quote to its contents after independent
  visual review found a wide, mostly empty quote panel.
- Kept the progress label in a stable-width slot and crossfaded its status icon.
  The completion state begins after the sample answer has finished streaming.
- Fixed the manual fixture to retain unquoted sends after cancelling a reply,
  preserve drafts across Viewer mode and resizing, and show the user's entered
  sample text. Repeated sends replace the one sample contribution by design.

## Reports and inspection limits

Wide and compact poster gates passed. The latest wide/compact flow and marked-state
gates printed `rehearsal passed`, with no forbidden layout findings. Their overall
status is nevertheless `inconclusive` (exit 2): timing samples have gaps of up to
40ms. The wide run also reports the old Swap text clone disappearing at the
status handoff; inspect the retained samples rather than treating the layout
gate as a frame-perfect motion certificate. Textarea typing is recorded as a
same-box text change for manual inspection.

The host-page geometry check at 390px passed. Interactive browser checks at
1280px and 390px exercised replies, cancellation, send, Activity, workspace
navigation, Viewer controls, reduced motion and draft preservation across resize.
The production native console was checked separately with its deterministic
integration harness; this React fixture is not embedded in it.

Independent GPT-6 Luna review inspected both final posters, both flow sheets,
the wide state sheet, and samples 0, 4 and 7 of all five beats. After the tighter
crop and reading column, it returned no remaining frame-supported findings.
It specifically checked the quoted context, composer, submitted reply and agent
handoff. No compact individual beat samples were supplied; compact detailed
motion remains unverified beyond the contact sheet.

Not checked: every intervening movie frame, physical touch hardware, 4× glyph
inspection, offscreen/hidden-tab suspension, pause/resume, or a new live AWS or
paid-provider run. There is no audio. The earlier real multiplayer recording
remains under `artifacts/shared-workspace/demo`; this design clip is separate.
