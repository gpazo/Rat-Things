import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

// Build-time only. Source/version/checksums are covered by worker image and native guest evidence.
const packs = {
  arm64: { bytes: 68249600, sha256: 'b6874fc0d7af15e16a15ef1b73177731f698c296c73d26aa4a90840c0777a338' },
  x64: { bytes: 70051840, sha256: '91b9f56d35a2cbb14279a1cbdaf1c86c0faa5fd82315bdd7334ff93bf35f224d' },
};
const pack = packs[process.arch];
if (!pack || process.platform !== 'linux') throw new Error('The shared browser requires an ARM64 or x64 Linux worker.');
const destination = '/opt/rat-browser';
const temp = await mkdtemp(join(tmpdir(), 'rat-browser-build-'));
try {
  const archive = join(temp, 'pack.tar');
  execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180', '--output', archive,
    `https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.${process.arch}.tar`], { stdio: 'inherit', timeout: 190000 });
  const bytes = await readFile(archive);
  if (bytes.length !== pack.bytes || createHash('sha256').update(bytes).digest('hex') !== pack.sha256) throw new Error('Chromium pack checksum differs from its pin.');
  execFileSync('tar', ['-xf', archive, '-C', temp, 'chromium.br', 'al2023.tar.br', 'fonts.tar.br', 'swiftshader.tar.br']);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const name of ['chromium', 'al2023.tar', 'fonts.tar', 'swiftshader.tar']) {
    const output = join(temp, name);
    await writeFile(output, brotliDecompressSync(await readFile(`${output}.br`), { maxOutputLength: 350 * 1024 * 1024 }));
    if (name === 'chromium') { await writeFile(join(destination, name), await readFile(output)); await chmod(join(destination, name), 0o755); }
    else execFileSync('tar', ['-xf', output, '-C', destination]);
  }
  const fonts = join(destination, 'fonts.conf');
  await writeFile(fonts, (await readFile(fonts, 'utf8')).replaceAll('/tmp/fonts-cache', '/workspace/.rat-things/browser/font-cache').replaceAll('/tmp/fonts', `${destination}/fonts`));
  await writeFile(join(destination, 'NOTICE'), `Chromium 153.0.0, distributed by @sparticuz/chromium.\nSource: https://github.com/Sparticuz/chromium/tree/v153.0.0\nChromium and bundled dependencies have separate licenses and notices: https://www.chromium.org/chromium-os/chromiumos-design-docs/licensing/\nPack SHA-256: ${pack.sha256}\n`);
} finally { await rm(temp, { recursive: true, force: true }); }
