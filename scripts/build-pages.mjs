import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = 'dist-pages';
const architectureAssets = [
  'c4-system-context.png',
  'c4-runtime-containers.png',
  'c4-localstack-test-harness-containers.png',
  'c4-live-aws-test-harness-containers.png',
];

await rm(output, { recursive: true, force: true });
await cp('site', output, { recursive: true });
await mkdir(join(output, 'assets', 'architecture'), { recursive: true });
await cp('assets/rat-things-hero.jpg', join(output, 'assets', 'rat-things-hero.jpg'));
for (const filename of architectureAssets) {
  await cp(join('docs', filename), join(output, 'assets', 'architecture', filename));
}
await writeFile(join(output, '.nojekyll'), '');

process.stdout.write(`built ${output} with ${architectureAssets.length + 1} image assets\n`);
