# Rat Things architecture explorer

The homepage is a Three.js spatial schematic of the implementation. It is a
teaching and inspection surface, not a deployment inventory or live Run console.
The previous homepage remains at `overview.html`; documentation and the existing
GitHub Pages release continue to use `scripts/build-pages.mjs` and `dist-pages`.

## Develop and validate

```sh
npm ci
npm run site:dev
# http://127.0.0.1:4173 — source changes rebuild the site; refresh to see them

npm run site:typecheck
npm run test:e2e:site
npm run check
```

Install the test browser once with `npx playwright install chromium`. The browser
suite starts its own static server when needed. It exercises real WebGL rendering,
mesh raycasting, drag rejection, exploded component inspection, all four request
walkthroughs, keyboard controls, deep links/back navigation, mobile/reduced-motion
use, missing data, no-WebGL fallback and the `/Rat-Things/` deployment prefix.
Screenshots and failure traces are written to `test-results/site`. CI runs the
browser suite after the repository checks. No AWS provisioning or actual agent
execution is involved in the website walkthroughs or these browser tests.

## Update the architecture

- `catalogue.json` owns the system/component hierarchy, human-readable explanations,
  connections and walkthroughs. Edit it alongside the implementation. IDs are stable
  deep-link identifiers; preserve them when renaming visible labels.
- Every system, component and connection requires source evidence: a repository
  `file` and an `anchor` that appears in its implementation. Prefer a distinctive
  symbol or operation over a generic word. The build resolves anchors to source
  lines and links to the current Git revision. The source content fingerprint changes
  when any referenced file changes. Anchors are checked, but the explanation's
  meaning still requires human review when behavior changes.
- To add a component, place it inside its owning system with a title, subtitle,
  description, facts and evidence. Its geometry, inspector, count and selection are
  generated from that entry. Adjust the system's position only when adding a new
  top-level system; positions are schematic, not physical network boundaries.
- Walkthrough steps reference component IDs and carry an explanatory state label.
  They illustrate successful paths. Conditional failures, cancellation and retries
  are explained in the relevant component details; the walkthrough is not a live
  state-machine simulator or evidence that a deployment has run successfully.
- Review `npm run site:build` failures for moved/deleted source anchors, duplicate
  IDs, missing evidence, and dangling connection or walkthrough targets. The browser
  receives only the bundled application and resolved catalogue; it does not import
  runtime code or obtain credentials.

## Code ownership

- `types.ts`: catalogue and view-state contracts.
- `app.ts`: accessible controls, inspector, URL state and walkthrough playback.
- `resources.ts` and `resource-manifest.json`: 28 reusable, distinct 3D resource assets.
  Each component chooses its asset through the `resource` field in the catalogue.
  To add a kind, add its manifest label and factory case; invalid references fail the build.
- `scene.ts`: geometry, smooth separation, raycasting, orbit/zoom and GPU cleanup.
- `styles.css`: shared visual tokens and responsive desktop/mobile layouts.
- `../../scripts/build-architecture.mjs`: source resolution and esbuild bundling.
- `../../tests/site/architecture-catalogue.test.ts`: evidence integrity checks.
- `../../e2e/site/architecture.browser.ts`: browser journeys and regression evidence.

The renderer uses no downloaded models, remote fonts or runtime CDN dependencies.
Its chip assemblies are visual groupings, not literal hardware specifications.
The catalogue and walkthrough remain usable if WebGL is unavailable. Rendering
pauses while the page is hidden and avoids GPU work while the view is unchanged.
Reduced-motion preferences disable automatic interpolation. Explicit rotation and
walkthrough controls remain opt-in.
