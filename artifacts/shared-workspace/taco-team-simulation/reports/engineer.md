# Engineer experience report

## Actions and evidence
- Inspected the shared session and opened its shared browser preview. The desktop page loaded at the displayed `rat-artifacts.invalid/index.html` route. Expanded the workspace to inspect the preview at a larger size. Screenshot: `/Users/gp/src/rat-things/.codex/pstack-runs/shared-feedback/taco-simulation/ui/engineer/1794769189593102000-d1bc23.png`.
- Opened Plan. It showed revision 1, “3 of 4 addressed”: sample menu, fictional visit details, and offline/informational constraints addressed. The 390 px check was marked “Agent deferred,” with the explanation that the shared browser opened at 1280 px and did not expose viewport resizing.
- Opened that Plan item. Its detail showed the QA message as a source, `index.html` as a result, and a Reply control. Clicking the source returned to the conversation and exposed Sam’s full request. Screenshot: `/Users/gp/src/rat-things/.codex/pstack-runs/shared-feedback/taco-simulation/ui/engineer/1794769207558353000-c6d096.png`.
- The page’s desktop preview had a warm cream background, large “Good tacos. Big sunshine.” hero, menu/visit links, and a green ticker. Top of the menu was visible below. Visual inspection only; no mobile or network verification.
- Round 1 steering appeared in the conversation when I revisited it. The agent replied that it would keep the page offline-safe and informational, with inline styling, no remote assets/forms, and sample visit details as plain text.

## What worked
Plan item detail connected the requirement to its source and result, and clearly distinguished addressed from deferred. The shared preview loaded and expanded workspace made visual review substantially easier.

## Problems
The browser/driver provided no viewport resize control, so the required narrow layout could not be checked. A click on the `index.html` tab did not return a tool result within about 10 seconds; I stopped trying to open the artifact through that tab. This appears to be a client/driver limitation, not evidence of a site failure. The visible page preview alone cannot establish that all assets are local or that network requests are absent.

## Top three improvements
1. Add a supported viewport-size control to the shared browser so reviewers can verify responsive layouts directly.
2. Make the artifact/source tab reliably open and provide a clear loading or error state when it cannot.
3. Provide a reviewer-visible network/local-assets check for offline-safety claims.

## Untested limits
Narrow rendering around 390 px, browser interactions/anchor destinations, lower-page menu and visit details, keyboard/accessibility behavior, and actual offline/network behavior were not verified. No correction message was sent because the unresolved narrow check was clearly documented and the remaining risks could not be assessed through the exposed controls.
