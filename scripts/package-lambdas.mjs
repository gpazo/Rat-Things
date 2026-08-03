import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { ZipArchive } from 'archiver';

const epoch = new Date('2000-01-01T00:00:00.000Z');
const lambdaRoot = 'dist/lambdas';
const lambdaNames = (await readdir(lambdaRoot)).sort();

for (const name of lambdaNames) {
  await zipEntries(`dist/${name}.zip`, [
    { source: join(lambdaRoot, name, 'index.mjs'), target: 'index.mjs', mode: 0o644 },
  ]);
}

const microvmEntries = [
  { source: 'dist/runner.mjs', target: 'runner.mjs', mode: 0o755 },
  { source: 'dist/terminate-microvm.mjs', target: 'terminate-microvm.mjs', mode: 0o755 },
  { source: 'config/codex.toml', target: 'config/codex.toml', mode: 0o644 },
  { source: 'scripts/git-askpass.sh', target: 'bin/git-askpass.sh', mode: 0o755 },
  ...(await recursiveFiles('microvm')).map((source) => ({
    source,
    target: relative('microvm', source),
    mode: basename(source).endsWith('.py') ? 0o755 : 0o644,
  })),
];
await zipEntries('dist/microvm-source.zip', microvmEntries);

async function recursiveFiles(root) {
  const output = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const information = await stat(path);
    if (information.isDirectory()) output.push(...await recursiveFiles(path));
    else if (information.isFile()) output.push(path);
  }
  return output;
}

async function zipEntries(outputPath, entries) {
  await mkdir('dist', { recursive: true });
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outputPath, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolvePromise);
    output.on('error', reject);
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.pipe(output);
    void (async () => {
      for (const entry of entries) {
        archive.append(await readFile(entry.source), {
          name: entry.target,
          date: epoch,
          mode: entry.mode,
        });
      }
      await archive.finalize();
    })().catch(reject);
  });
  process.stdout.write(`created ${outputPath}\n`);
}
