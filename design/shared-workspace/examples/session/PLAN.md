# Session conversation redesign

Medium: one 12–16 second stageshow flow, played once, plus an interactive fixture.
Desktop 960×620; compact 358×600 presentation. Same dark Rat Things tokens, Inter,
mark and semantic participant colors as the artifact workspace. No new palette.

Focal object: one ongoing conversation. Maya, Eli and Sam contribute to the same
agent, see the reply context, and see the agent keep working. The composer remains
available throughout; a saved message is not presented as model completion.

Gold: copy ai-chat for a user message arriving, activity state and a streamed
answer. Retain its Collapse/Stream choreography. Borrow the existing workspace
study's measured cursor and participant color conventions. Film ai-chat first.

Native changes:
- Put conversation/workspace navigation with the Session title and actions.
- Give every message an author rail, with neutral body text and colored authors.
- Make quoted replies visually distinct and keep the original-message action.
- Keep reply/copy affordances available by hover and keyboard focus without loud
  per-message buttons. Drafts and message IDs remain the same.
- Put one human-readable activity state above the bounded composer. Runtime and
  raw Turn metadata remain in Details. Use actual status, never invented progress.
- Keep setup navigation, roles, fixed capabilities and existing service effects.

Constraints: no online-presence claim from contributor history; no fabricated
percentage, timing estimate, invitation flow, mobile client or new backend.
Prototype is explicitly sample data. Read-only users stay read-only.

Validate: send, steering, cancel reply, original-message navigation, preserved drafts,
slow/failed refresh and narrow windows. Wide/compact posters and animation gate;
fresh-eye review. Existing native and repository checks. No paid model inference.

Review refinement: crop to the conversation and its own toolbar. Sidebar setup
navigation stays in the native app; it does not help tell this reply/progress story.
Tighten message pitch and shorten the stage together, preserving the composer.
