# QA Round 2

- Re-inspected the shared Rat Things client. The shared browser was already at `index.html#visit`, consistent with another reviewer having moved the shared page before my inspection. The screenshot showed the visit section and sticky header; its viewport was still desktop-sized.
- Clicked the native `Phone viewport` control. It switched to a narrow 390px preview. At the captured state, the page was scrolled partway through the menu: the header remained sticky, visible item names and prices (including Sunbeam Al Pastor $4.75, Street Corn Cup $4.00, Chips & Guac $6.00, Hibiscus Agua Fresca $3.50) were aligned without clipping, and the Visit section began lower in the same viewport. Screenshot: `ui/qa/1794786532556922000-ad62e8.png`.
- Tried the brief's `point` action over the visible Visit us and Menu controls. Both returned `error: null` but did not activate navigation; the pointer moved over the controls and the address remained `#visit`. The native browser toolbar controls became disabled during this period, then re-enabled in the subsequent inspection. I did not observe a click rejection from my own attempts. Another reviewer’s message in the shared session says their pixel-coordinate click was rejected as outside the viewport; that is their reported driver error, not one reproduced by me.
- Missing check: I could not perform the Menu → Visit tap sequence, so sticky-anchor title visibility after tapping remains unverified. The visual layout did show the sticky header and visible prices in the phone-width preview. No product issue was confirmed, so I did not stage an annotation.

Screenshots captured:

- `ui/qa/1794786519908573000-ccb0bd.png` (shared `#visit`, desktop viewport)
- `ui/qa/1794786532556922000-ad62e8.png` (phone viewport, menu/visit transition)
- `ui/qa/1794786542127145000-b44b39.png` (after pointer over Menu; no navigation)
- `ui/qa/1794786553534471000-6fdbcb.png` (repeat pointer over Menu; no navigation)
