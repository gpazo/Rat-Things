import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { renderPreview } from '../site/fork-demo/themes.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const previewOnly = process.argv.includes('--preview-only');
if (process.argv.slice(2).some(arg => arg !== '--preview-only')) throw new Error('Only --preview-only is supported.');
const directory = 'test-results/fork-video';
await mkdir(directory, { recursive: true });
const provenance = JSON.parse(await readFile('scripts/fork-video/provenance.json', 'utf8'));
const evaluation = JSON.parse(await readFile('scripts/fork-video/evaluation.json', 'utf8'));
if (evaluation.designs.length !== 5 || new Set(evaluation.designs.map(design => design.key)).size !== 5 ||
  !evaluation.designs.some(design => design.key === evaluation.winner) ||
  evaluation.designs.some(design => design.ratings.length !== 4 || design.ratings.some(rating => !['Strong', 'Mixed', 'Weak'].includes(rating))))
  throw new Error('Complete the five-option review before rendering.');
const seconds = 68;
const html = { starter: renderPreview('starter') };
for (const { key } of evaluation.designs) {
  html[key] = await readFile(`scripts/fork-video/fixtures/${key}.html`, 'utf8');
  if (createHash('sha256').update(html[key]).digest('hex') !== provenance.artifacts[key]) throw new Error(`The real ${key} artifact changed.`);
}
const browser = await chromium.launch({ headless: true });
let encoder;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // The film is a local presentation replay. Frames cannot fetch external content.
  await page.route('**/*', route => route.abort());
  const siteTheme = await readFile('site/docs.css', 'utf8');
  const scene = await readFile('scripts/fork-video/scene.html', 'utf8');
  await page.setContent(scene.replace('<!-- SITE_THEME -->', `<style>${siteTheme}</style>`));
  await page.evaluate(data => window.loadFrames(data), { html, evaluation });
  await page.evaluate(() => document.fonts.ready);
  const samples = [2, 9, 14, 19, 23, 25, 28.5, 30.5, 34, 36, 39.5, 41.5, 43.5, 49, 57, 59, 65];
  for (const time of samples) {
    await page.evaluate(t => window.paint(t), time);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.caption,.finding p,.recommendation,h1,h2,h3')]
      .filter(element => getComputedStyle(element).visibility === 'visible')
      .filter(element => element.scrollWidth > element.clientWidth + 1 || element.getBoundingClientRect().bottom > 1028)
      .map(element => element.textContent));
    if (overflow.length) throw new Error(`Text does not fit at ${time}s: ${overflow.join('; ')}`);
    await page.screenshot({ path: `${directory}/frame-${time}.jpg`, type: 'jpeg', quality: 90 });
  }
  if (!previewOnly) {
    const output = 'assets/session-fork-demo.mp4';
    encoder = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', '24', '-i', 'pipe:0', '-an', '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { stdio: ['pipe', 'inherit', 'inherit'] });
    const completion = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
      encoder.stdin.on('error', reject);
    });
    // Observe failures immediately even if encoding fails between screenshot writes.
    completion.catch(() => {});
    for (let frame = 0; frame < seconds * 24; frame++) {
      await page.evaluate(t => window.paint(t), frame / 24);
      const bytes = await page.screenshot({ type: 'jpeg', quality: 92 });
      if (!encoder.stdin.write(bytes)) await Promise.race([once(encoder.stdin, 'drain'), completion.then(() => { throw new Error('Encoder exited before all frames were written.'); })]);
      if (frame % 120 === 0) console.log(`Rendered ${(frame / 24).toFixed(0)} / ${seconds} seconds`);
    }
    encoder.stdin.end();
    await completion;
    await page.evaluate(() => window.paint(14));
    await page.screenshot({ path: 'assets/session-fork-demo-poster.jpg', type: 'jpeg', quality: 90 });
    const probe = spawn('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
    let metadata = '';
    probe.stdout.on('data', data => { metadata += data; });
    const [code] = await once(probe, 'exit');
    if (code !== 0) throw new Error('ffprobe failed.');
    const info = JSON.parse(metadata);
    const stream = info.streams.find(stream => stream.codec_type === 'video');
    if (stream.width !== 1920 || stream.height !== 1080 || stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p' || Math.abs(Number(info.format.duration) - seconds) > .05) throw new Error('Unexpected video format.');
    await writeFile(`${directory}/export.json`, JSON.stringify({ output, seconds: Number(info.format.duration), width: stream.width, height: stream.height, bytes: Number(info.format.size), provenance, errors }, null, 2) + '\n');
    console.log(`Created ${output} · ${seconds} seconds · 1920 × 1080 · ${(Number(info.format.size) / 1024 / 1024).toFixed(1)} MiB`);
  }
  if (errors.length) throw new Error(errors.join('; '));
} finally {
  encoder?.kill();
  await browser.close();
}
