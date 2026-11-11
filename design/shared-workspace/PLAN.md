# Shared workspace redesign

Medium: an interactive design prototype with a 15-second, once-only stageshow
walkthrough and a complete reduced-motion poster. Desktop design width 1080;
compact composition 358 in a 390 viewport. The existing real capture remains
separate; this prototype is labeled and makes no service requests.

Focal object: the artifact being reviewed, with its discussion visible beside it.
The Session is the enclosing object. People never leave the conversation to review
an artifact, and a reply never loses the original evidence.

Action and payoff: capture the live page, pin a concern, receive another person's
reply, then see the same agent incorporate the shared feedback. The captured
version remains visible throughout the conversation.

Gold: copy presence for participant identity and measured targets, with
panel-annotation for the relationship between an artifact and a contextual note.
Film both before adapting. Borrow structure and choreography, not their palette.

Look: Rat Things dark neutral surfaces, Inter 400/500/600, white primary actions,
indigo selection/working state, assigned participant colors only for identity.
Load the repository's brand.css before local styles and use the real dog mark.
Map --ss-* to --rt-*; no additional visual palette.

Layout:
- A persistent Session header holds title, people and the existing space/role.
- Conversation and Work are adjacent on desktop; compact layouts switch between
  them without discarding drafts or selected evidence.
- Artifact tabs show live browser, captured review and files by name.
- A mode bar says Live browser or Captured page, with Return to live in context.
- A selected pin opens its discussion next to the captured page.
- One composer names its reply/annotation context, with an icon-only cancel.
- One agent-status location separates collecting feedback, working and completed.
- Other people's typing is visible with names; the current person's own typing
  is never presented as remote presence.

Constraints:
- One agent for the whole Session. No specialist-agent handoffs.
- Existing space roles, no new private/restricted Session ACLs.
- Browser actions stay fenced to the displayed revision; no automatic replay.
- Captures are immutable; navigation never moves existing annotations.
- No mid-Session capability expansion.
- Participant history is not an online-presence claim. No invented live cursor
  protocol, invitation flow, permissions bypass, offline engine or new backend.
- Prototype sample roles and agent responses are explicit fixtures.

Omit from the short walkthrough: setup, URLs and IDs, credential configuration,
details JSON, resolve/reopen and long transcript history. Keep those available
where relevant in the manual prototype and native implementation.

Review: wide and compact opening/poster/motion, keyboard and manual interactions,
viewer state, mid-action navigation, reduced motion and replay. Film gates plus
fresh-eye review. Keep a REHEARSAL.md alongside the component.
