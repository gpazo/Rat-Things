#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [baselineArgument, candidateArgument, outputArgument] = process.argv.slice(2);
if (process.argv.length !== 5 || !baselineArgument || !candidateArgument || !outputArgument) {
  throw new Error('usage: node startup-randomized-image.mjs <baselineZIP> <candidateZIP> <outputZIP>');
}
const baselineZip = realpathSync(resolve(baselineArgument));
const candidateZip = realpathSync(resolve(candidateArgument));
const outputZip = resolve(outputArgument);
if (outputZip === baselineZip || outputZip === candidateZip) throw new Error('outputZIP must differ from both source ZIPs');
const outputDirectory = dirname(outputZip);
mkdirSync(outputDirectory, { recursive: true });
const work = mkdtempSync(join(outputDirectory, '.startup-randomized-image-'));
const context = join(work, 'context');
const tempZip = join(work, 'randomized-source.zip');
const manifestName = 'startup-overlap-manifest.json';
const selectorVersion = 'run-id-final-hex-parity.v1';
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: context, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'signal'}): ${(result.stderr ?? '').slice(-2_000)}`);
  return result.stdout ?? '';
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => {
  const hash = createHash('sha256');
  const bytes = readFileSync(path);
  hash.update(bytes);
  return hash.digest('hex');
};
const entries = (archive) => run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean);
const entry = (archive, name) => spawnSync('unzip', ['-p', archive, name], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
const readEntry = (archive, name) => {
  const result = entry(archive, name);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not read ${name} from ${archive}`);
  return result.stdout;
};
const zipInfo = (archive, name) => {
  const details = run('unzip', ['-Z', '-v', archive, name]);
  const mode = details.match(/Unix file attributes \(([0-7]+) octal\):/);
  const crc = details.match(/32-bit CRC value \(hex\):\s*([a-f0-9]{8})/i);
  if (!mode || !crc) throw new Error(`could not inspect ZIP metadata for ${name}`);
  const parsed = Number.parseInt(mode[1], 8);
  if ((parsed & 0o170000) === 0o120000) throw new Error(`source ZIP contains symlink ${name}`);
  return { mode: parsed & 0o777, crc: crc[1].toLowerCase() };
};
const getFunction = (source, endName) => {
  const start = source.indexOf('function startRun(run) {');
  if (start < 0 || source.indexOf('function startRun(run) {', start + 1) !== -1) throw new Error('expected one startRun(run) function');
  const boundary = source.indexOf(`\nfunction ${endName}(`, start);
  if (boundary < 0) throw new Error(`missing top-level function boundary ${endName}`);
  const code = source.slice(start, boundary).trimEnd();
  if (!code.endsWith('}')) throw new Error('startRun function boundary is malformed');
  return { start, boundary, code };
};

try {
  mkdirSync(context);
  const candidateNames = entries(candidateZip);
  const baselineNames = entries(baselineZip);
  const validateNames = (names, label) => {
    const counts = new Map();
    for (const name of names) {
      if (name.startsWith('/') || name.split('/').some((part) => part === '..')) throw new Error(`${label} ZIP contains unsafe path`);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count !== 1)) throw new Error(`${label} ZIP contains duplicate entries`);
    return counts;
  };
  const candidateCounts = validateNames(candidateNames, 'candidate source');
  const baselineCounts = validateNames(baselineNames, 'baseline source');
  for (const name of ['runtime-server.mjs', 'Dockerfile']) {
    if (candidateCounts.get(name) !== 1 || baselineCounts.get(name) !== 1) throw new Error(`both ZIPs must contain exactly one ${name}`);
  }
  if (candidateCounts.has(manifestName)) throw new Error('candidate ZIP already contains a startup overlap overlay');
  if (candidateCounts.has('startup-responses-proxy-manifest.json') || candidateCounts.has('startup-responses-proxy.mjs')) {
    throw new Error('apply the randomized startup overlay before the Responses proxy overlay');
  }
  const candidateRuntime = readEntry(candidateZip, 'runtime-server.mjs').toString('utf8');
  const baselineRuntime = readEntry(baselineZip, 'runtime-server.mjs').toString('utf8');
  const baseline = getFunction(baselineRuntime, 'parseControlRoute');
  const candidate = getFunction(candidateRuntime, 'releaseStartupGate');
  if (candidateRuntime.includes('function startSerialRun(') || candidateRuntime.includes('function startOverlapRun(')) throw new Error('candidate runtime already contains a renamed comparison function');
  const baselineNamed = baseline.code.replace(/^function startRun\(run\)/, 'function startSerialRun(run)');
  const candidateNamed = candidate.code.replace(/^function startRun\(run\)/, 'function startOverlapRun(run)');
  const selector = `function startupComparisonSide(runId) {\n  const finalHex = /([0-9a-f])$/i.exec(runId)?.[1];\n  if (!finalHex) throw new Error('Run ID must end in a hexadecimal character');\n  return Number.parseInt(finalHex, 16) % 2 === 0 ? 'before' : 'after';\n}`;
  const wrapper = `function startRun(run) {\n  const side = startupComparisonSide(run.runId);\n  const selectedAt = new Date().toISOString();\n  log('info', 'startup comparison selected', { runId: run.runId, side, selectedAt });\n  if (side === 'before') return startSerialRun(run);\n  return startOverlapRun(run);\n}`;
  const comparisonCode = `${baselineNamed}\n\n${candidateNamed}\n\n${selector}\n\n${wrapper}`;
  const runtime = candidateRuntime.slice(0, candidate.start) + `${comparisonCode}\n` + candidateRuntime.slice(candidate.boundary);
  const candidateMode = zipInfo(candidateZip, 'runtime-server.mjs').mode;
  writeFileSync(join(context, 'runtime-server.mjs'), runtime, { mode: candidateMode });
  chmodSync(join(context, 'runtime-server.mjs'), candidateMode);
  const sourceTimestamp = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(join(context, 'runtime-server.mjs'), sourceTimestamp, sourceTimestamp);
  const baselineHash = sha256(Buffer.from(baseline.code));
  const candidateHash = sha256(Buffer.from(candidate.code));
  const manifest = {
    schema: 'rat-things.startup-overlap.v1',
    selectorVersion,
    baselineFunctionSha256: baselineHash,
    candidateFunctionSha256: candidateHash,
    baselineSourceZipSha256: fileHash(baselineZip),
    candidateSourceZipSha256: fileHash(candidateZip),
    comparisonCodeSha256: sha256(Buffer.from(comparisonCode)),
  };
  writeFileSync(join(context, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  chmodSync(join(context, manifestName), 0o444);
  copyFileSync(candidateZip, tempZip);
  const deleteResult = spawnSync('zip', ['-q', '-d', tempZip, 'runtime-server.mjs'], { cwd: context, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  if (deleteResult.error) throw deleteResult.error;
  if (deleteResult.status !== 0) throw new Error(`zip entry replacement failed (${deleteResult.status ?? 'signal'}): ${(deleteResult.stderr ?? '').slice(-2_000)}`);
  const zipResult = spawnSync('zip', ['-q', tempZip, 'runtime-server.mjs', manifestName], { cwd: context, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  if (zipResult.error) throw zipResult.error;
  if (zipResult.status !== 0) throw new Error(`zip update failed (${zipResult.status ?? 'signal'}): ${(zipResult.stderr ?? '').slice(-2_000)}`);
  const outputNames = entries(tempZip);
  const outputCounts = validateNames(outputNames, 'output');
  for (const [name, count] of candidateCounts) if (outputCounts.get(name) !== count) throw new Error(`overlay changed candidate entry count for ${name}`);
  if (outputCounts.size !== candidateCounts.size + 1 || outputCounts.get(manifestName) !== 1) throw new Error('overlay must add only the comparison manifest');
  for (const name of candidateNames) {
    const before = zipInfo(candidateZip, name);
    const after = zipInfo(tempZip, name);
    if (before.mode !== after.mode) throw new Error(`overlay changed candidate ZIP mode for ${name}`);
    if (name !== 'runtime-server.mjs' && before.crc !== after.crc) throw new Error(`overlay changed candidate ZIP content for ${name}`);
  }
  if (zipInfo(tempZip, 'runtime-server.mjs').mode !== candidateMode || zipInfo(tempZip, manifestName).mode !== 0o444) throw new Error('overlay produced unexpected file modes');
  const encodedManifest = JSON.parse(readEntry(tempZip, manifestName).toString('utf8'));
  if (JSON.stringify(encodedManifest) !== JSON.stringify(manifest)) {
    throw new Error('output manifest provenance check failed');
  }
  renameSync(tempZip, outputZip);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(`created randomized startup comparison source ZIP ${outputZip}\n`);
