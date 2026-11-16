# QA round 1

- Read the team brief and inspected the selected `Taco Cometa · Clear confirmations` Session in the QA native client.
- Initial bridge invocation used `QA` and returned an assertion error because the bridge accepts lowercase role names. Retried with `qa`; inspection succeeded.
- The Session showed Alex's brief and the designer and engineer contributions. The agent was still working; the browser preview showed a Demo plan waiting for the team's brief, so there was no site draft to assess yet.
- Sent one contribution: “QA acceptance: please make the sample menu and sample visit details easy to distinguish at a glance, and ensure the page remains readable and keyboard navigable on phone.” The first Enter inserted a newline and did not send it. I clicked the observed `Steer` button once. A subsequent inspect showed the contribution in the conversation and an empty Message field, confirming it was saved; no retry was made.
- Screenshot paths: `../screenshots/qa/1794800568077168000-d5af87.png` (initial Session), `../screenshots/qa/1794800595464518000-c60ee6.png` (saved contribution).
- Uncertainty: the initial screenshot showed only the preview's Demo plan placeholder. I did not assess a rendered website or keyboard behavior; the note is an acceptance criterion for the draft, not a claim that these checks passed.
