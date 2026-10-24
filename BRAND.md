# Rat Things brand and style guide

Every Rat Things surface — the desktop console, the GitHub Pages site, the documentation,
the 3D architecture explorer and the SVG diagrams — uses this one visual system. It follows
the restraint of Linear: a dark neutral canvas, one quiet accent, Inter, and no decoration
that does not carry information.

The desktop theme in [`desktop/src/theme.rs`](desktop/src/theme.rs) is the reference
implementation. Web surfaces read the same values from [`site/brand.css`](site/brand.css).
Change a value in both places or in neither.

## Name and reference

**Rat Things** takes its name from the robotic dogs in *Snow Crash*. Use the full
product name in prose, onboarding and interface copy. Do not shorten it to "Rat"
or invent a separate mascot name.

A Rat Thing is a cybernetic guard dog, not a rodent. In the novel the units are built from
dogs (Fido, the one readers meet, was a pit bull), run on a radioisotope that never stops making
heat, shed that heat through radiator fins, and wait in a hutch until they are needed. Draw on
those traits without naming a breed: a lean, wolf-like head, machined planes, a sensor slot for an
eye, and radiator fins. Do not draw rat ears, whiskers or a long, curling, naked tail.

## Principles

- **Neutral first.** Surfaces, lines and text are grays. Color is the exception and must mean
  something.
- **One accent.** Indigo marks focus, links, selection and "working" state. It is never a
  background wash, a gradient or a section theme.
- **Light primary.** The primary action is a light fill with dark text, not a colored button.
- **Flat surfaces.** Depth comes from a step in the gray scale and a 1px border, not from glows,
  radial gradients or tinted shadows.
- **Sentence case.** Labels, kickers and buttons use sentence case. No letter-spaced uppercase.

## Voice

Plain and specific. Say what the system does in the reader's terms, then stop.

- Headings make a short claim: "The machine can stop. The work continues."
- Kickers name the topic, not a slogan: "How work survives", "Authority is decided before launch".
- Buttons say exactly what happens: "Deploy your agent cloud", "Trace a Session", "New session".
- Product nouns are capitalized as defined terms: Agent, Session, Turn, Item, Vault.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--rt-bg-deep` | `#111112` | Alternate full-width sections, media wells |
| `--rt-bg` | `#181819` | Page and window background |
| `--rt-panel` | `#1c1c1d` | Sidebars, diagram frames, top bars |
| `--rt-card` | `#202022` | Cards, secondary buttons |
| `--rt-surface` | `#252527` | Inputs, inactive controls, emphasized cards |
| `--rt-selected` | `#303033` | Selected row or control |
| `--rt-hover` | `#333336` | Hovered control |
| `--rt-border` | `#2e2e31` | Default 1px border |
| `--rt-border-strong` | `#3e3e44` | Hovered border, secondary button border |
| `--rt-text` | `#f7f8f8` | Primary text and headings (16.7:1 on `--rt-bg`) |
| `--rt-text-secondary` | `#d0d6e0` | Lede paragraphs, emphasized supporting text (12.1:1) |
| `--rt-muted` | `#8a8f98` | Supporting text, kickers, labels, step numbers (5.5:1; 4.7:1 on `--rt-surface`) |
| `--rt-faint` | `#62666d` | Disabled text and fine print only (3.1:1, below 4.5:1) |
| `--rt-accent` | `#828fff` | Focus rings, links, selection stroke, "working" status (6.2:1) |
| `--rt-primary-fill` | `#e5e5e6` | Primary button fill (`--rt-primary-text` `#181819` on top, 14.1:1) |

Status colors are muted and appear only on status indicators, never as decoration:
success `#a1bfa2`, warning `#dfbf84`, error `#ec9f9b`.

Retired: the cyan (`#80e6ff`), amber (`#ffb13b`), mint (`#89edc8`), lime (`#b0e865`) and teal-tinted
surfaces used by earlier pages, and the rat-tailed character illustration. Do not reintroduce them.

Product mocks may use the depicted product's own colors where recognition depends on it — for
example, Linear's mark in a Linear issue mock. Keep those inside the mock.

## Typography

- **Inter** for everything, in three weights: 400 (body), 500 (labels, buttons, kickers) and
  600 (headings, brand). Do not use 700 or heavier.
- The desktop app embeds Inter (`desktop/assets/fonts`). The web stack is `var(--rt-font)`.
- Headings use tight, not crushed, tracking: about `-0.02em` to `-0.025em`, line-height 1.0–1.1.
- Body text uses normal tracking and line-height 1.55–1.65.
- Monospace (`var(--rt-mono)`) is for code, commands, identifiers and numeric data — not for
  labels or kickers.

| Style | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| Web hero | 76px / 1.0, `-0.025em` | 600 | Overview hero; about 46px on phones |
| Web section heading | 56px / 1.05, `-0.025em` | 600 | Section headings |
| Web card title | 21.6px / 1.2 | 600 | Card and step titles |
| Web lede | 21.6px / 1.55 | 400 | Paragraph under a hero, in `--rt-text-secondary` |
| Web body | 16px / 1.6 | 400 | Running text |
| Web kicker | 13.6px / 1.4 | 500 | Label above a heading, in `--rt-muted` |
| Desktop heading | 19px | 600 | egui `TextStyle::Heading` |
| Desktop body / button | 13px | 400 / 500 | egui `Body` and `Button` |
| Desktop small | 11px | 400 | Sidebar section labels, hints |
| Desktop mono | 12px | 400 | Commands, identifiers |

## Shape and spacing

- Radius: `6px` for small controls, `8px` for buttons and cards, `12px` for large media and
  section cards. Desktop uses 5px and 7px at its denser scale.
- Borders are always 1px.
- Controls are 30px tall on desktop and 40px on the web.
- Desktop spacing: 6px button padding (vertical), 8px item gap, 12px button padding (horizontal),
  16px card padding, 22px window margin. Web pages keep at least a 16px side gutter on phones.
- Shadows only on floating layers (menus, windows, raised media), always neutral black.

## Logo

The Rat Things mark is **a Rat Thing's head in profile**: a robotic guard dog with wolf lines,
facing right with its head lowered. Radiator fins rake back across the neck and taper toward the
back; the heat of the isotope core rises through them from the base in the accent color. The face
is one solid plate with a sensor slot for an eye. One geometry, generated on a 512px grid by
[`scripts/build-brand-marks.mjs`](scripts/build-brand-marks.mjs), produces every version:

| File | Use |
| --- | --- |
| `assets/brand/rat-things-mark.svg` | **Feature mark.** The glyph on its graphite tile. Copied to [`site/favicon.svg`](site/favicon.svg) for every web header and favicon |
| `assets/brand/rat-things-mark-1024.png` | Feature mark as a bitmap; the site's touch icon |
| `assets/brand/rat-things.icns` | macOS app icon for both app bundles (the tile on Apple's icon grid) |
| `desktop/assets/brand/app-icon-256.png` | The same icon as the console's window and Dock icon when it runs unbundled |
| `desktop/assets/brand/glyph-96.png` | The heat glyph beside the product name in the console sidebar |
| `assets/brand/rat-things-glyph-heat.svg` / `-heat-dark.svg` | The glyph alone with heat fins, for dark and light grounds |
| `assets/brand/rat-things-lockup-dark.svg` / `-light.svg` | Heat glyph beside the wordmark, for dark and light grounds |
| `assets/brand/rat-things-mark-flat.svg` | **Flat mark.** One `--rt-text` ink on an `--rt-bg` tile, where color is unavailable |
| `assets/brand/rat-things-glyph-light.svg` / `-dark.svg` | The glyph in one ink, for embossing, print and single-color use |
| `assets/brand/rat-things-hero.svg` | The glyph at display scale for the overview hero |
| `assets/brand/rat-things-og.png` | 1200 × 630 Open Graph card for the website |
| `assets/brand/rat-things-social-preview.png` | 1280 × 640 card for the GitHub repository's social preview |

**Construction.** The silhouette is a tall pointed ear, a brow that slopes into a long lowered
snout, a clean jaw line with no mouth, and a neck cut flat at the base. A seam parallel to the fins
divides the face plate from the fins. Fins lean back 0.62px per px of height, sit 14px apart and
narrow from 28px beside the face to 5px at the back. The eye and the gaps between fins are cut out,
so every version works on any ground.

**Heat.** On dark grounds the fins run from `--rt-accent` at the base through `#c3c9f8` to
`--rt-text` at the top, and the face is `--rt-text`. On light grounds the fins run from
`--rt-accent` to `#181819` and the face is `#181819`. The fins are what keep a Rat Thing running,
and the accent marks "working". This is the only place the brand uses gradients. The feature
tile adds a graphite gradient (`#2c2c30` to `#121213`) and a top-lit rim; keep both inside the tile.

- Wordmark: "Rat Things" in Inter 600, sentence case, tracking `-0.02em`, beside the glyph. The
  lockups set it as outlines, so they render without Inter installed.
- Don't mirror the glyph, recolor the face, move the heat off the fins, add a mouth or a tail, add
  effects outside the tile, or set the wordmark in uppercase.
- Leave clear space around the mark of at least a quarter of its width.
- Run `node scripts/build-brand-marks.mjs` after changing the geometry. It writes the SVGs, the
  favicon and, through Playwright's Chromium, every PNG and the `.icns` (which needs macOS
  `iconutil`).

## Character artwork

The mark is the brand's character. Pages that need display art, such as the overview hero, use
the glyph at scale ([`assets/brand/rat-things-hero.svg`](assets/brand/rat-things-hero.svg)) rather
than a separate illustration. New artwork follows the description under
[Name and reference](#name-and-reference) and the heat colors above, on a neutral black ground
with no blue, cyan or amber light.

## Diagrams

SVG diagrams in `docs/` use the token values directly, because they render outside the site
(for example on GitHub):

- Frame `#1c1c1d` with a `#2e2e31` stroke; nodes `#202022` with a `#3e3e44` stroke.
- The one node that answers the diagram's question gets a `#252527` fill and an accent
  `#828fff` stroke.
- Flows and arrows are `#8a8f98`. Labels `#f7f8f8` at weight 600; details `#8a8f98`.

The 3D architecture explorer follows the same rule. Systems are graphite with light-gray
edges. The page chrome uses the accent only for focus.

## Applying it

- Link `brand.css` before the page stylesheet and build from `--rt-*` tokens. Page stylesheets may
  alias tokens (for example `--muted: var(--rt-muted)`) but must not define new colors.
- Primary button: `--rt-primary-fill` background, `--rt-primary-text` text, `--rt-radius`.
- Secondary button: `--rt-card` background, `--rt-border-strong` border, `--rt-hover` on hover.
- Text link: `--rt-accent`. Focus: `2px solid var(--rt-accent)` outline.
- Kicker above a heading: `--rt-muted`, Inter 500, about 0.85rem, sentence case.
