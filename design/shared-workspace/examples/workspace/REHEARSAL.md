# Rehearsal: Shared workspace

Gold: stageshow `presence` (one consistent color per contributor) and
`panel-annotation` (connect discussion to the specific object). Copied and filmed
both before implementing the scene. Replaced their product identity with Rat Things
brand tokens, embedded Inter fonts and the existing Rat Things mark.

Beats: live shared browser → capture → numbered pin → designer/engineer/QA
feedback → one agent carries the constraints forward. Play once; the exported
16-second clip holds the outcome. Reduced motion shows the completed discussion.

Captured: desktop scene 1080×750; compact scene 358×680 in a 390px viewport;
reduced-motion posters; complete wide and compact contact sheets; marked states;
individual samples around capture, pin, reply, agent and completion. The compact
phone is a presentation study, not an implemented mobile client.

## Corrections

- Messages were truncated by the kit Row preview. Kept Row authorship headers and
  rendered message bodies separately with wrapping.
- Compact work and discussion were squeezed together. Gave them distinct views
  with a persistent captured-evidence reference and navigation.
- The author-initial marker looked like presence. Replaced it with pin 1, an
  outlined target and a matching numbered, quoted reference above the discussion.
- Idle composer copy repeated the same explanation. Removed that repetition;
  typing still uses a reserved line so the composer does not jump.
- Capture actions now crossfade in a stable control slot; changing mode and
  composer context use retained Swap elements.
- Manual state now comes directly from the reducer; the Stage's poster is a
  static illustration state, not a controlled-state API. Artifact-specific drafts
  and cancel-reply preservation were exercised through the browser.

## Gate and visual review

Final wide and compact loop gates and the wide marked-state gate passed.
The adjacent work/discussion borders produce a 1px near-tangent notice: this is
an intentional pane divider, not overlapping content. Alignment notices compare
text inside the composer card with labels outside it; their separate container
insets were inspected. The film tool reports some Swap clone handoffs as missing
exits and records sampling gaps. Those are retained in the JSON reports; they
are not a claim of continuous frame-perfect motion coverage.

An independent GPT-6 Luna reviewer compared the supplied golds and posters,
then inspected frames 0, 4 and 7 of each beat. The initial finding was an unclear
pin-to-discussion relationship; after the numbered pin and quoted reference,
no further concrete framing or annotation-link finding remained in those samples.

## Assumptions and limits

The browser, participants, roles and agent response in this study are local sample
state. It makes no service calls. The native implementation uses the existing
collaboration services and permissions; it does not embed this React prototype.
Native contributor labels describe contribution history, not who is currently
online. The capture/render boundary and fixed capability envelope are unchanged.

Not checked: every intervening movie frame, audio (there is none), 4× glyph
inspection, a mobile application, a new live AWS deployment, or a new paid-provider
run. The separate real multiplayer recording remains under
`artifacts/shared-workspace/demo`; this design clip must not be presented as that
live service recording.
