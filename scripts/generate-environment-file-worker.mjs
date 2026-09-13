import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

for (const [path, entry] of [['src/adapters/environment-file-worker', 'environmentFileWorker'], ['src/runner/environment-mcp-worker', 'environmentMcpWorker']]) {
const source = await readFile(`${path}.ts`, 'utf8');
const { code } = await transform(`${source}\nvoid ${entry}();`, { loader: 'ts', format: 'iife', platform: 'node', target: 'node22', keepNames: false });
const generated = `${JSON.stringify(code)}\n`;
const target = `${path}-source.json`;
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8').catch(() => '') !== generated) throw new Error('Run npm run agents-api:worker to regenerate the environment file worker');
} else await writeFile(target, generated);
}
