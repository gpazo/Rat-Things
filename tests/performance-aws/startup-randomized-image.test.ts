import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateStartupManifest, validateStartupOverlapManifest } from '../../testing/performance-aws/startup-planning.js';

const baselineRuntime = `function startRun(run) {
  baselineStart(run);
}
function parseControlRoute(rawUrl) { return rawUrl; }
`;
const candidateRuntime = `function startRun(run) {
  candidateStart(run);
}
function releaseStartupGate(stream, onError) { return Boolean(stream && onError); }
function parseControlRoute(rawUrl) { return rawUrl; }
server.listen(8080, process.env.DEFAULT_EXECUTION_BACKEND === 'ec2' ? '127.0.0.1' : '0.0.0.0', () => {
});
`;

function zipFixture(directory: string, name: string, runtime: string, extras: Record<string, string> = {}) {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'runtime-server.mjs'), runtime, { mode: 0o644 });
  writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n', { mode: 0o644 });
  writeFileSync(join(root, 'unchanged.txt'), 'keep exactly\n', { mode: 0o640 });
  for (const [path, contents] of Object.entries(extras)) {
    const filePath = join(root, path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  const zipPath = join(directory, `${name}.zip`);
  execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: root });
  return zipPath;
}

const zipEntry = (zip: string, name: string) => execFileSync('unzip', ['-p', zip, name]);
const zipMode = (zip: string, name: string) => {
  const info = execFileSync('unzip', ['-Z', '-v', zip, name], { encoding: 'utf8' });
  const mode = info.match(/Unix file attributes \(([0-7]+) octal\):/);
  if (!mode) throw new Error(`missing mode for ${name}`);
  return Number.parseInt(mode[1]!, 8) & 0o777;
};

describe('randomized startup source overlay', () => {
  it('keeps candidate ZIP entries and modes, then survives the fixture proxy overlay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'startup-randomized-overlay-'));
    try {
      const baseline = zipFixture(directory, 'baseline', baselineRuntime);
      const candidate = zipFixture(directory, 'candidate', candidateRuntime, {
        Dockerfile: readFileSync(resolve('microvm/Dockerfile'), 'utf8'),
        'config/codex.toml': readFileSync(resolve('config/codex.toml'), 'utf8'),
        'assets/model.txt': 'binary-adjacent fixture',
      });
      const output = join(directory, 'combined.zip');
      const fixture = join(directory, 'randomized-fixture.zip');
      execFileSync(process.execPath, [resolve('testing/performance-aws/startup-randomized-image.mjs'), baseline, candidate, output]);
      execFileSync(process.execPath, [resolve('testing/performance-aws/startup-responses-proxy-image.mjs'), output, fixture, '--mode', 'fixture']);
      const runtimeBytes = zipEntry(fixture, 'runtime-server.mjs');
      const runtime = runtimeBytes.toString('utf8');
      const manifest = JSON.parse(zipEntry(fixture, 'startup-overlap-manifest.json').toString('utf8'));
      const originalFunction = candidateRuntime.slice(0, candidateRuntime.indexOf('\nfunction releaseStartupGate')).trimEnd();
      const baselineFunction = baselineRuntime.slice(0, baselineRuntime.indexOf('\nfunction parseControlRoute')).trimEnd();
      expect(manifest).toMatchObject({
        schema: 'rat-things.startup-overlap.v1', selectorVersion: 'run-id-final-hex-parity.v1',
        baselineFunctionSha256: createHash('sha256').update(baselineFunction).digest('hex'),
        candidateFunctionSha256: createHash('sha256').update(originalFunction).digest('hex'),
      });
      expect(() => validateStartupOverlapManifest(manifest, runtimeBytes)).not.toThrow();
      expect(runtime).toContain('function startSerialRun(run)');
      expect(runtime).toContain('function startOverlapRun(run)');
      expect(runtime).toContain('startup comparison selected');
      expect(runtime).toContain("await startStartupResponsesProxy({ mode: 'fixture' });");
      const proxyManifest = JSON.parse(zipEntry(fixture, 'startup-responses-proxy-manifest.json').toString('utf8'));
      expect(() => validateStartupManifest(proxyManifest, 'fixture')).not.toThrow();
      const comparisonStart = runtime.indexOf('function startupComparisonSide(runId)');
      const comparisonEnd = runtime.indexOf('\n\nfunction releaseStartupGate(', comparisonStart);
      const runSelected = new Function('run', 'log', 'startSerialRun', 'startOverlapRun',
        `${runtime.slice(comparisonStart, comparisonEnd).trimEnd()}; return startRun(run);`) as
        (run: { runId: string }, log: (...args: unknown[]) => void, serial: (run: { runId: string }) => void,
          candidate: (run: { runId: string }) => void) => void;
      for (let suffix = 0; suffix < 16; suffix++) {
        const selected: string[] = [];
        const logs: unknown[][] = [];
        const runId = `fixture-${suffix.toString(16)}`;
        runSelected({ runId }, (...args) => logs.push(args), () => selected.push('before'), () => selected.push('after'));
        expect(selected).toEqual([suffix % 2 === 0 ? 'before' : 'after']);
        expect(logs[0]).toMatchObject(['info', 'startup comparison selected', { runId, side: suffix % 2 === 0 ? 'before' : 'after' }]);
        expect((logs[0]![2] as Record<string, unknown>).selectedAt).toEqual(expect.any(String));
      }
      expect(zipEntry(output, 'unchanged.txt')).toEqual(zipEntry(candidate, 'unchanged.txt'));
      expect(zipEntry(output, 'assets/model.txt')).toEqual(zipEntry(candidate, 'assets/model.txt'));
      expect(zipMode(output, 'runtime-server.mjs')).toBe(zipMode(candidate, 'runtime-server.mjs'));
      expect(zipMode(output, 'unchanged.txt')).toBe(zipMode(candidate, 'unchanged.txt'));
      expect(zipMode(output, 'startup-overlap-manifest.json')).toBe(0o444);
      const originalEntries = execFileSync('unzip', ['-Z1', candidate], { encoding: 'utf8' }).trim().split('\n').sort();
      const outputEntries = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' }).trim().split('\n').sort();
      expect(outputEntries).toEqual([...originalEntries, 'startup-overlap-manifest.json'].sort());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['invalid ZIP', 'missing function', 'name collision', 'existing overlay'])('rejects invalid source ZIPs: %s', failure => {
    const directory = mkdtempSync(join(tmpdir(), 'startup-randomized-reject-'));
    try {
      const baseline = zipFixture(directory, 'baseline', baselineRuntime);
      const invalid = failure === 'invalid ZIP'
        ? join(directory, 'invalid.zip')
        : zipFixture(directory, 'invalid', failure === 'missing function' ? 'function parseControlRoute(rawUrl) {}\n'
          : failure === 'name collision' ? `${candidateRuntime}\nfunction startRun(run) {}\n`
            : candidateRuntime, failure === 'existing overlay' ? { 'startup-overlap-manifest.json': '{}' } : {});
      if (failure === 'invalid ZIP') writeFileSync(invalid, 'not a ZIP archive');
      const output = join(directory, 'output.zip');
      const result = spawnSync(process.execPath, [resolve('testing/performance-aws/startup-randomized-image.mjs'), baseline, invalid, output], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
