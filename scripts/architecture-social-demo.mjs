import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { beginRecording, makeCaptions, storyboard } from './architecture-demo/recorder.mjs';
import { exportDemo } from './architecture-demo/export.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const exportOnly = process.argv.includes('--export-only');
const unknown = process.argv.slice(2).filter(argument => argument !== '--export-only');
if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} exited with ${code}`);
}

let server;
let browser;
try {
  // Use an independent local server so a user's open explorer stays untouched.
  if (!exportOnly) {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
    await run('npm', ['run', 'site:build']);
    server = spawn(process.execPath, ['scripts/serve-site.mjs', '--port=4175'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Preview server did not start.')), 10000);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview server exited with ${code}. Port 4175 must be free.`)); });
      server.stdout.on('data', chunk => {
        if (chunk.toString().includes('http://127.0.0.1:4175')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    browser = await chromium.launch({ headless: true });
    await makeCaptions(browser);
    const recording = await beginRecording(browser, { baseUrl: 'http://127.0.0.1:4175/' });
    for (let index = 0; index < storyboard.length; index++) {
      console.log(await recording.recordChapter(index));
    }
    console.log(await recording.finish());
    await browser.close();
    browser = undefined;
    server.kill();
    server = undefined;
  }
  const result = await exportDemo({ onProgress: ({ chapter, completed, total }) => console.log(`Exported ${completed}/${total}: ${chapter}`) });
  console.log(`Created ${result.video}\n${result.seconds.toFixed(1)} seconds · 1080 × 1080 · ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
} finally {
  await browser?.close();
  server?.kill();
}
