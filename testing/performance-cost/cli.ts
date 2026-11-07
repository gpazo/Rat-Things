import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compareViewerBaseline, estimateCost, parseLogExport, parseManifest, parseRateCard } from './cost.js';

const usage = 'Usage: node --import tsx testing/performance-cost/cli.ts --manifest phase.json --rates rates.json [--baseline baseline.json]';
async function json(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text) as unknown; } catch { throw new Error('Input configuration is not valid JSON'); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--manifest', '--rates', '--baseline'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  const manifestPath = options.get('--manifest'), ratesPath = options.get('--rates');
  if (!manifestPath || !ratesPath) throw new Error(usage);
  const card = parseRateCard(await json(ratesPath));
  async function estimate(path: string) {
    const manifest = parseManifest(await json(path));
    const inputs = await Promise.all(manifest.sources.map(async source => ({ source, events: (await Promise.all(source.files.map(async file =>
      parseLogExport(await readFile(resolve(dirname(path), file), 'utf8'))))).flat() })));
    return estimateCost(manifest, card, inputs);
  }
  const current = await estimate(manifestPath);
  const baselinePath = options.get('--baseline');
  const comparison = baselinePath ? compareViewerBaseline(current, await estimate(baselinePath)) : {
    label: 'Marginal viewer-hour estimate unavailable', usdPerViewerHour: null,
    basis: 'Supply a measured zero-viewer baseline for the same functions and a positive measured viewerHours value.',
  };
  console.log(JSON.stringify({ ...current, marginalViewerHour: comparison }, null, 2));
}
main().catch(error => {
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Unable to read cost inputs');
  process.exitCode = 1;
});
