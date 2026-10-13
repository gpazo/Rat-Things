# Rat Things brand and style guide

Every Rat Things surface — the desktop console, the GitHub Pages site, the documentation,
the 3D architecture explorer and the SVG diagrams — uses this one visual system. It follows
the restraint of Linear: a dark neutral canvas, one quiet accent, Inter, and no decoration
that does not carry information.

The desktop theme in [`desktop/src/theme.rs`](desktop/src/theme.rs) is the reference
implementation. Web surfaces read the same values from [`site/brand.css`](site/brand.css).
Change a value in both places or in neither.

## Principles

- **Neutral first.** Surfaces, lines and text are grays. Color is the exception and must mean
  something.
- **One accent.** Indigo marks focus, links, selection and "working" state. It is never a
  background wash, a gradient or a section theme.
- **Light primary.** The primary action is a light fill with dark text, not a colored button.
- **Flat surfaces.** Depth comes from a step in the gray scale and a 1px border, not from glows,
  radial gradients or tinted shadows.
- **Sentence case.** Labels, kickers and buttons use sentence case. No letter-spaced uppercase.

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
| `--rt-text` | `#f7f8f8` | Primary text and headings |
| `--rt-text-secondary` | `#d0d6e0` | Lede paragraphs, emphasized supporting text |
| `--rt-muted` | `#8a8f98` | Supporting text, kickers, labels, step numbers |
| `--rt-faint` | `#62666d` | Disabled text, fine print |
| `--rt-accent` | `#828fff` | Focus rings, links, selection stroke, "working" status |
| `--rt-primary-fill` | `#e5e5e6` | Primary button fill (`--rt-primary-text` `#181819` on top) |

Status colors are muted and appear only on status indicators, never as decoration:
success `#a1bfa2`, warning `#dfbf84`, error `#ec9f9b`.

Retired: the cyan (`#80e6ff`), amber (`#ffb13b`), mint (`#89edc8`), lime (`#b0e865`) and teal-tinted
surfaces used by earlier pages. Do not reintroduce them.

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

## Shape and spacing

- Radius: `6px` for small controls, `8px` for buttons and cards, `12px` for large media and
  section cards. Desktop uses 5px and 7px at its denser scale.
- Borders are always 1px.
- Controls are 30px tall on desktop and 40px on the web.
- Shadows only on floating layers (menus, windows, raised media), always neutral black.

## Logo

The Rat Things mark is an **R whose leg becomes a rat's tail**, drawn as an off-white stroke on a
dark rounded tile with a `--rt-border-strong` outline. The source is
[`site/favicon.svg`](site/favicon.svg); headers use the same file at 22–24px.

- Wordmark: "Rat Things" in Inter 600, sentence case, beside the mark.
- Don't recolor the mark, add a glow, or set the wordmark in uppercase.

## The Rat

The cybernetic Rat illustration ([`assets/rat-things-hero.jpg`](assets/rat-things-hero.jpg)) is the
brand's character. It is graded to monochrome so it sits inside the neutral system. The amber eye
and core glow are kept on purpose: amber exists **only inside the Rat illustration** and is never
used as a UI color. The social card is [`assets/rat-things-og-v3.jpg`](assets/rat-things-og-v3.jpg).

When you regrade or recreate Rat artwork, keep the background neutral black and remove
blue or cyan light.

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
