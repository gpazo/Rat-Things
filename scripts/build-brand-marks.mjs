// Generates the Rat Things mark family in assets/brand/ from one geometry. See BRAND.md.
// Usage: node scripts/build-brand-marks.mjs
import { copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import opentype from 'opentype.js';

const OUT = 'assets/brand';
const FONTS = 'desktop/assets/fonts';
mkdirSync(OUT, { recursive: true });

// ---- Glyph geometry on a 512 grid -------------------------------------------------
const W = 46; // stroke weight
const stem = { x: 168, top: 128, bottom: 384 };
const bowlR = 64;
const bowlX = 276; // where the bowl's straight top ends
const bowlBottom = stem.top + bowlR * 2; // 256
const leg = { x1: 250, y1: bowlBottom, x2: 316, y2: 352 };
// Tail centerline: two cubic segments, sweeping right along the baseline and curling up.
const tail = [
  [[leg.x2, leg.y2], [335.25, 380], [372, 402], [410, 398]],
  [[410, 398], [450, 394], [474, 360], [460, 326]],
  [[460, 326], [450, 302], [420, 300], [414, 322]],
];

const cubic = ([p0, p1, p2, p3], t) => {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
};
const tailPoints = [];
function tailOutline(widthStart, widthEnd) {
  const pts = [];
  const N = 90;
  for (let s = 0; s < tail.length; s++) {
    for (let i = s === 0 ? 0 : 1; i <= N; i++) pts.push(cubic(tail[s], i / N));
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len.at(-1);
  const left = [], right = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    const nx = -dy / d, ny = dx / d;
    const t = len[i] / total;
    const w = (widthEnd + (widthStart - widthEnd) * Math.pow(1 - t, 1.35)) / 2;
    tailPoints.push(p);
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
  });
  const f = (n) => n.toFixed(1);
  const end = pts.at(-1);
  const r = widthEnd / 2;
  return (
    'M' + left.map((p) => `${f(p[0])} ${f(p[1])}`).join('L') +
    'L' + right.reverse().map((p) => `${f(p[0])} ${f(p[1])}`).join('L') + 'Z'
  );
}

const rPath = `M${stem.x} ${stem.bottom}V${stem.top}H${bowlX}A${bowlR} ${bowlR} 0 0 1 ${bowlX} ${bowlBottom}H${stem.x}`;
const legPath = `M${leg.x1} ${leg.y1}L${leg.x2} ${leg.y2}`;
const tailPath = tailOutline(W, 6);
const tailPathFlat = tailOutline(W + 6, 9);

// Optical centering: the glyph spans x 145..~452, y 105..~407.
const xs = [stem.x - W / 2, bowlX + bowlR + W / 2, ...tailPoints.map((p) => p[0])];
const ys = [stem.top - W / 2, stem.bottom + W / 2, ...tailPoints.map((p) => p[1] + 6)];
const glyph = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
const shift = (size) => `translate(${(256 - glyph.cx).toFixed(1)} ${(256 - glyph.cy).toFixed(1)})`;

// ---- Feature mark: the presentation version -------------------------------------
function featureMark({ id = 'rt', size = 512 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-labelledby="${id}-title">
  <title id="${id}-title">Rat Things</title>
  <defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c2c30"/>
      <stop offset="1" stop-color="#121213"/>
    </linearGradient>
    <linearGradient id="${id}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="${id}-ink" x1="0" y1="105" x2="0" y2="400" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#c3c9d4"/>
    </linearGradient>
    <linearGradient id="${id}-tail" x1="316" y1="352" x2="470" y2="340" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#cdd2dc"/>
      <stop offset="0.3" stop-color="#8f9aff"/>
      <stop offset="0.7" stop-color="#7280ff"/>
      <stop offset="1" stop-color="#aab2ff"/>
    </linearGradient>
    <radialGradient id="${id}-bloom" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#828fff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#828fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
    <clipPath id="${id}-clip"><rect width="512" height="512" rx="114"/></clipPath>
  </defs>
  <g clip-path="url(#${id}-clip)">
    <rect width="512" height="512" fill="url(#${id}-tile)"/>
    <g transform="${shift()}">
      <ellipse cx="420" cy="352" rx="120" ry="96" fill="url(#${id}-bloom)"/>
    </g>
  </g>
  <rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="url(#${id}-rim)" stroke-width="3"/>
  <g transform="${shift()}" filter="url(#${id}-shadow)">
    <g fill="none" stroke="url(#${id}-ink)" stroke-width="${W}" stroke-linecap="round" stroke-linejoin="round">
      <path d="${rPath}"/>
      <path d="${legPath}"/>
    </g>
    <path d="${tailPath}" fill="url(#${id}-tail)"/>
  </g>
</svg>
`;
}

// ---- Flat mark: favicon and header sizes ----------------------------------------
function flatMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="4" y="4" width="504" height="504" rx="112" fill="#181819" stroke="#3e3e44" stroke-width="8"/>
  <g transform="${shift()}">
    <path d="${tailPathFlat}" fill="#f7f8f8"/>
    <g fill="none" stroke="#f7f8f8" stroke-width="${W + 6}" stroke-linecap="round" stroke-linejoin="round">
      <path d="${rPath}"/>
      <path d="${legPath}"/>
    </g>
  </g>
</svg>
`;
}

// ---- Glyph only: one ink, for print, embossing, light backgrounds ---------------
function glyphOnly(ink) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(Math.min(...xs) - 12 + 256 - glyph.cx).toFixed(0)} ${(Math.min(...ys) - 12 + 256 - glyph.cy).toFixed(0)} ${(Math.max(...xs) - Math.min(...xs) + 24).toFixed(0)} ${(Math.max(...ys) - Math.min(...ys) + 24).toFixed(0)}" role="img" aria-label="Rat Things">
  <g transform="${shift()}">
    <path d="${tailPath}" fill="${ink}"/>
    <g fill="none" stroke="${ink}" stroke-width="${W}" stroke-linecap="round" stroke-linejoin="round">
      <path d="${rPath}"/>
      <path d="${legPath}"/>
    </g>
  </g>
</svg>
`;
}

// ---- Lockup: feature mark + outlined wordmark ----------------------------------
const semibold = opentype.loadSync(`${FONTS}/Inter-SemiBold.ttf`);
function wordmark(text, x, baseline, size, tracking) {
  let cursor = x;
  const parts = [];
  const glyphs = semibold.stringToGlyphs(text);
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(cursor, baseline, size).toPathData(1));
    const next = glyphs[i + 1];
    const kern = next ? semibold.getKerningValue(g, next) : 0;
    cursor += ((g.advanceWidth + kern) / semibold.unitsPerEm) * size + tracking * size;
  });
  return { d: parts.join(''), width: cursor - x };
}
function lockup(theme) {
  const ink = theme === 'dark' ? '#f7f8f8' : '#181819';
  const word = wordmark('Rat Things', 0, 0, 200, -0.02);
  const markSize = 240, gap = 72;
  const capHeight = (semibold.tables.os2.sCapHeight / semibold.unitsPerEm) * 200;
  const width = Math.ceil(markSize + gap + word.width + 8);
  const height = markSize;
  const baseline = (height + capHeight) / 2;
  const inner = featureMark({ id: `lk-${theme}` }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Rat Things">
  <svg x="0" y="0" width="${markSize}" height="${markSize}" viewBox="0 0 512 512">${inner}</svg>
  <path transform="translate(${markSize + gap} ${baseline.toFixed(1)})" d="${word.d}" fill="${ink}"/>
</svg>
`;
}

writeFileSync(`${OUT}/rat-things-mark.svg`, featureMark());
writeFileSync(`${OUT}/rat-things-mark-flat.svg`, flatMark());
writeFileSync(`${OUT}/rat-things-glyph-light.svg`, glyphOnly('#f7f8f8'));
writeFileSync(`${OUT}/rat-things-glyph-dark.svg`, glyphOnly('#181819'));
writeFileSync(`${OUT}/rat-things-lockup-dark.svg`, lockup('dark'));
writeFileSync(`${OUT}/rat-things-lockup-light.svg`, lockup('light'));
copyFileSync(`${OUT}/rat-things-mark-flat.svg`, 'site/favicon.svg');
console.log(`wrote ${OUT} and site/favicon.svg`);
