#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmod, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const searchRoot = resolve('test-results/console');
const output = resolve(process.env.RAT_THINGS_CONSOLE_DEMO_PATH ?? 'test-results/rat-things-console-demo.mp4');
const videos = await findVideos(searchRoot);
if (videos.length === 0) throw new Error(`No Playwright video was found under ${searchRoot}`);
const source = videos.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
if (!source) throw new Error(`No Playwright video was found under ${searchRoot}`);

await mkdir(dirname(output), { recursive: true });
const result = spawnSync('ffmpeg', [
  '-hide_banner',
  '-loglevel', 'error',
  '-y',
  '-i', source,
  '-an',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  output,
], { stdio: 'inherit' });
if (result.error) {
  throw new Error(`ffmpeg is required to export the MP4 demo: ${result.error.message}`);
}
if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status ?? 'unknown'}`);
await chmod(output, 0o600);
process.stdout.write(`Console demo: ${output}\n`);

async function findVideos(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const videos = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) videos.push(...await findVideos(path));
    else if (entry.isFile() && entry.name.endsWith('.webm')) {
      videos.push({ path, ...(await stat(path)) });
    }
  }
  return videos;
}
