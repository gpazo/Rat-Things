# QA final review

## Initial state and recovery

On opening the Session, the conversation showed “Updated Plan · revision 3”; the agent reported moving the phone links to their own row with larger text and padded tap targets, then reloading at 390 × 844. The designer said the feedback was resolved, the agent confirmed that, and the Plan showed “5 of 5 addressed” with all five entries marked “Addressed.” A toast still said “The request timed out. Your draft is preserved.” I dismissed it using the observed “Dismiss error” control. The toast disappeared and the page remained visible; I did not retry or alter the draft.

## What I reviewed

- The phone preview showed the revised header: the Taco Cometa mark/name on one row and three separate, large Menu / Our story / Visit controls below it. The hero headline, supporting copy, CTA, and large illustration fit in the 390 × 844 phone viewport.
- Scrolling showed sample menu cards with prices, multiple vegetarian labels, a story section, and a dark visit section labeled “Sample visit details.” At the captured position, the visit card displayed an example address. The visible menu and visit labels make the fictional details clear.
- The collaboration flow was easy to follow: the designer’s feedback was visible and resolved, the agent described its change and phone check, and the Plan advanced from active work to all five items addressed. “Ready for the next step” appeared below the Plan summary.
- Screenshots: `../screenshots/qa/1794800948637154000-77b997.png` (revision 3, resolved feedback, timeout toast); `../screenshots/qa/1794800964798211000-8cb0da.png` (revised phone header and hero); `../screenshots/qa/1794800984032590000-be6c72.png` (menu cards and vegetarian markers); `../screenshots/qa/1794801000460015000-452693.png` (story and sample visit details); `../screenshots/qa/1794801014666035000-6f0ba7.png` (after dismissing the toast).

## Ratings

- **Clarity: 4/5.** Plan statuses and the agent’s description made progress clear. The recurring timeout toast briefly conflicted with the completed revision, though it explicitly said the draft was preserved and the page remained available after dismissal.
- **Collaboration: 5/5.** The designer’s concrete phone concern, the agent’s specific acknowledgement, the visible resolution, and the Plan’s addressed status formed a clear review-to-change trail.
- **Artifact review: 4/5.** The native browser preview made it possible to inspect the changed phone header and scroll through the menu, story, and visit area. I did not test the links, keyboard navigation, or another viewport.

## Remaining issues and limits, prioritized

1. The timeout notice recurred across views after the revision appeared complete. “Your draft is preserved” helped, and dismissal recovered the clean view, but the repeated notice can leave save/operation status uncertain.
2. I did not activate the three header links or CTA, so their destinations and behavior remain unverified.
3. I reviewed the visual phone preview only. I did not verify keyboard focus, semantic navigation, a full desktop layout, or behavior at other screen sizes; those are review limits, not observed failures.
