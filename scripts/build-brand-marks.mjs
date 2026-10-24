// Generates the Rat Things mark family from one geometry. See BRAND.md.
// Usage: node scripts/build-brand-marks.mjs
//
// The mark is a Rat Thing from Snow Crash: a robotic guard dog in profile, head lowered,
// with wolf lines. Radiator fins rake back across its neck and carry the heat of its
// isotope core, rising from the base in the accent color. The face is one solid plate
// with a sensor slot for an eye.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { chromium } from '@playwright/test';

const OUT = 'assets/brand';
const DESKTOP = 'desktop/assets/brand';
const FONTS = 'desktop/assets/fonts';
mkdirSync(OUT, { recursive: true });
mkdirSync(DESKTOP, { recursive: true });

const INK = '#f7f8f8';
const DARK = '#181819';
const ACCENT = '#828fff';
const f = (n) => +n.toFixed(2);

// ---- Figure geometry on a 512 grid, facing right ----------------------------------
const HEAD = [
  'M222 66L286 166', // tall pointed ear
  'L350 172L394 196L452 226L476 246', // sloping brow into a long, lowered snout
  'L462 262L408 270L378 298L338 322L310 334', // clean jaw line back to the throat
  'L344 404L146 404L160 322L150 214Z', // neck and back of the skull
].join('');
const EYE = 'M322 192L384 210L374 220L328 206Z';
const RAKE = 0.62; // fins lean back this many px per px of height
const FIN_GAP = 14;
const SEAM = 480; // where the face meets the fins, measured along the bottom edge
const HEAT = { y0: 404, y1: 98 }; // the heat gradient rises from the base of the neck

// Fins taper from the face toward the back of the neck.
const fins = (() => {
  const paths = [];
  for (let x = SEAM - FIN_GAP / 2, i = 0; x > -300; i++) {
    const w = Math.max(5, 28 - i * 3.2);
    paths.push(`M${f(x - w)} 512L${f(x)} 512L${f(x - 512 * RAKE)} 0L${f(x - w - 512 * RAKE)} 0Z`);
    x -= w + FIN_GAP;
  }
  return paths.map((d) => `<path d="${d}"/>`).join('');
})();
const FACE_SIDE = `M${SEAM} 512L${f(SEAM - 512 * RAKE)} 0H600V512Z`;

// Place the figure on the 512 tile: centered, 90% scale.
const PLACE = 'translate(256 256) scale(0.9) translate(-312 -240)';
const bounds = { x0: 146, x1: 476, y0: 66, y1: 404 };
const placed = (x, y) => [256 + 0.9 * (x - 312), 256 + 0.9 * (y - 240)];

// Paints: `face` is a color; `fin` is a color, 'heat' (for dark grounds) or 'heat-dark'
// (for light grounds). The eye and the gaps between fins are always cut out.
function figure(id, { face, fin }) {
  const heat = fin === 'heat' || fin === 'heat-dark';
  const [mid, top] = fin === 'heat-dark' ? ['#9ea6f0', DARK] : ['#c3c9f8', INK];
  return `<defs>
    <linearGradient id="${id}-heat" x1="0" y1="${HEAT.y0}" x2="0" y2="${HEAT.y1}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACCENT}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${top}"/>
    </linearGradient>
    <clipPath id="${id}-head"><path d="${HEAD}"/></clipPath>
    <clipPath id="${id}-face"><path d="${FACE_SIDE}"/></clipPath>
    <mask id="${id}-eye" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="#fff"/><path d="${EYE}" fill="#000"/>
    </mask>
  </defs>
  <g transform="${PLACE}">
    <g clip-path="url(#${id}-head)">
      <g fill="${heat ? `url(#${id}-heat)` : fin}">${fins}</g>
      <g clip-path="url(#${id}-face)"><path d="${HEAD}" fill="${face}" mask="url(#${id}-eye)"/></g>
    </g>
  </g>`;
}

const tile = (id) => `<defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c2c30"/><stop offset="1" stop-color="#121213"/>
    </linearGradient>
    <linearGradient id="${id}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="114" fill="url(#${id}-tile)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="url(#${id}-rim)" stroke-width="3"/>`;

// ---- Marks ------------------------------------------------------------------------
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="Rat Things">
  ${body}
</svg>
`;
const inner = (markup) => markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const featureMark = (id = 'rt') => svg('0 0 512 512', `${tile(id)}\n  ${figure(id, { face: INK, fin: 'heat' })}`);
const flatMark = () => svg('0 0 512 512', `<rect x="4" y="4" width="504" height="504" rx="112" fill="${DARK}" stroke="#3e3e44" stroke-width="8"/>
  ${figure('rtf', { face: INK, fin: INK })}`);
const glyphBox = (() => {
  const pad = 14;
  const [x0, y0] = placed(bounds.x0, bounds.y0);
  const [x1, y1] = placed(bounds.x1, bounds.y1);
  return { x: f(x0 - pad), y: f(y0 - pad), w: f(x1 - x0 + pad * 2), h: f(y1 - y0 + pad * 2) };
})();
const glyphViewBox = `${glyphBox.x} ${glyphBox.y} ${glyphBox.w} ${glyphBox.h}`;
const glyph = (id, paints) => svg(glyphViewBox, figure(id, paints));
const glyphWidth = (height) => (glyphBox.w / glyphBox.h) * height;
// The glyph placed on a larger artboard, for lockups and cards.
const glyphAt = (id, paints, x, y, height) =>
  `<svg x="${f(x)}" y="${f(y)}" width="${f(glyphWidth(height))}" height="${f(height)}" viewBox="${glyphViewBox}">${figure(id, paints)}</svg>`;

// ---- Outlined Inter text --------------------------------------------------------
const semibold = opentype.loadSync(`${FONTS}/Inter-SemiBold.ttf`);
const regular = opentype.loadSync(`${FONTS}/Inter-Regular.ttf`);
function outline(font, value, size, tracking = -0.02) {
  let cursor = 0;
  const parts = [];
  const glyphs = font.stringToGlyphs(value);
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(cursor, 0, size).toPathData(1));
    const next = glyphs[i + 1];
    cursor += ((g.advanceWidth + (next ? font.getKerningValue(g, next) : 0)) / font.unitsPerEm) * size + tracking * size;
  });
  return { d: parts.join(''), width: cursor };
}
const capHeight = (size) => (semibold.tables.os2.sCapHeight / semibold.unitsPerEm) * size;
const text = (t, x, baseline, fill) => `<path transform="translate(${f(x)} ${f(baseline)})" d="${t.d}" fill="${fill}"/>`;

// ---- Lockup: glyph + outlined wordmark ------------------------------------------
function lockup(theme) {
  const ink = theme === 'dark' ? INK : DARK;
  const paints = theme === 'dark' ? { face: INK, fin: 'heat' } : { face: DARK, fin: 'heat-dark' };
  const word = outline(semibold, 'Rat Things', 200);
  const height = 240, gap = 56;
  const width = Math.ceil(glyphWidth(height) + gap + word.width + 8);
  return svg(`0 0 ${width} ${height}`, `${glyphAt(`lk-${theme}`, paints, 0, 0, height)}
  ${text(word, glyphWidth(height) + gap, (height + capHeight(200)) / 2, ink)}`);
}

// ---- Cards ------------------------------------------------------------------------
function socialPreview() {
  const W = 1280, H = 640, markHeight = 200, gap = 40;
  const word = outline(semibold, 'Rat Things', 132);
  const tagline = outline(regular, 'The open-source backend for cloud agents, self-hosted in your AWS account.', 30, 0);
  const x = (W - (glyphWidth(markHeight) + gap + word.width)) / 2, top = 172;
  return svg(`0 0 ${W} ${H}`, `<rect width="${W}" height="${H}" fill="#111112"/>
  ${glyphAt('sp', { face: INK, fin: 'heat' }, x, top, markHeight)}
  ${text(word, x + glyphWidth(markHeight) + gap, top + (markHeight + capHeight(132)) / 2, INK)}
  ${text(tagline, (W - tagline.width) / 2, top + markHeight + 92, '#8a8f98')}`);
}
function openGraphCard() {
  const W = 1200, H = 630, left = 80;
  const brand = outline(semibold, 'Rat Things', 34);
  const headline = ['VM-level', 'isolation at', 'serverless scale.'].map((line) => outline(semibold, line, 76, -0.025));
  const lede = ['The open-source backend for cloud agents,', 'self-hosted in your AWS account.'].map((line) => outline(regular, line, 27, 0));
  return svg(`0 0 ${W} ${H}`, `<rect width="${W}" height="${H}" fill="#111112"/>
  ${glyphAt('og-art', { face: INK, fin: 'heat' }, 716, 104, 430)}
  ${glyphAt('og-mark', { face: INK, fin: 'heat' }, left, 66, 44)}
  ${text(brand, left + glyphWidth(44) + 16, 66 + (44 + capHeight(34)) / 2, INK)}
  ${headline.map((line, i) => text(line, left, 238 + i * 80, INK)).join('\n  ')}
  ${lede.map((line, i) => text(line, left, 486 + i * 38, '#d0d6e0')).join('\n  ')}`);
}

// Hero art for the overview page: the glyph at display scale on the right. The page lays
// its own scrim over the left side for the copy.
function heroArt() {
  const W = 1600, H = 900, height = 640;
  return svg(`0 0 ${W} ${H}`, glyphAt('hero', { face: INK, fin: 'heat' }, W - glyphWidth(height) - 150, (H - height) / 2 + 20, height));
}

// ---- macOS app icon: the feature tile on Apple's 1024 icon grid ---------------------
const appIcon = () => svg('0 0 1024 1024', `<defs><filter id="ai-shadow" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter></defs>
  <g filter="url(#ai-shadow)"><svg x="100" y="100" width="824" height="824" viewBox="0 0 512 512">${inner(featureMark('ai'))}</svg></g>`);

async function rasterize(jobs) {
  const browser = await chromium.launch();
  try {
    for (const { markup, width, height, path, transparent } of jobs) {
      const page = await browser.newPage({ viewport: { width, height } });
      const sized = markup.replace('<svg ', `<svg width="${width}" height="${height}" `);
      await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${sized}`);
      await page.locator('svg').first().screenshot({ path, omitBackground: Boolean(transparent) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

writeFileSync(`${OUT}/rat-things-mark.svg`, featureMark());
writeFileSync(`${OUT}/rat-things-mark-flat.svg`, flatMark());
writeFileSync(`${OUT}/rat-things-glyph-light.svg`, glyph('gl', { face: INK, fin: INK }));
writeFileSync(`${OUT}/rat-things-glyph-dark.svg`, glyph('gd', { face: DARK, fin: DARK }));
writeFileSync(`${OUT}/rat-things-glyph-heat.svg`, glyph('gh', { face: INK, fin: 'heat' }));
writeFileSync(`${OUT}/rat-things-glyph-heat-dark.svg`, glyph('ghd', { face: DARK, fin: 'heat-dark' }));
writeFileSync(`${OUT}/rat-things-lockup-dark.svg`, lockup('dark'));
writeFileSync(`${OUT}/rat-things-lockup-light.svg`, lockup('light'));
writeFileSync(`${OUT}/rat-things-hero.svg`, heroArt());
copyFileSync(`${OUT}/rat-things-mark.svg`, 'site/favicon.svg');

const iconset = `${OUT}/rat-things.iconset`;
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
await rasterize([
  { markup: featureMark('png'), width: 1024, height: 1024, path: `${OUT}/rat-things-mark-1024.png`, transparent: true },
  { markup: socialPreview(), width: 1280, height: 640, path: `${OUT}/rat-things-social-preview.png` },
  { markup: openGraphCard(), width: 1200, height: 630, path: `${OUT}/rat-things-og.png` },
  { markup: appIcon(), width: 256, height: 256, path: `${DESKTOP}/app-icon-256.png`, transparent: true },
  { markup: glyph('dg', { face: INK, fin: 'heat' }), width: Math.round(glyphWidth(96)), height: 96, path: `${DESKTOP}/glyph-96.png`, transparent: true },
  ...[16, 32, 128, 256, 512].flatMap((size) => [
    { markup: appIcon(), width: size, height: size, path: `${iconset}/icon_${size}x${size}.png`, transparent: true },
    { markup: appIcon(), width: size * 2, height: size * 2, path: `${iconset}/icon_${size}x${size}@2x.png`, transparent: true },
  ]),
]);
if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', iconset, '-o', `${OUT}/rat-things.icns`]);
else console.warn('iconutil is macOS-only; kept the existing rat-things.icns');
rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${OUT}, ${DESKTOP} and site/favicon.svg`);
