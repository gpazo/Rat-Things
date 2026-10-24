import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { nativeProofCpuCount } from './runtime.js';
import { arch, release, totalmem } from 'node:os';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '6' }, cpus: { type: 'string', default: '1' } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Choose 1 to 20 sequential runs');
const cpuCount = nativeProofCpuCount(values.cpus);
const directory = await mkdtemp(resolve('.runtime/local-vm-worker/reliability-'));
const manifest = JSON.parse(await readFile(resolve('.runtime/local-vm-worker/manifest.json'), 'utf8')) as Record<string, unknown>;
const image = { initrdSha256: manifest.initrdSha256, kernelSha256: manifest.kernelSha256, helperSha256: manifest.helperSha256 };
const host = { architecture: arch(), release: release(), memoryMiB: Math.floor(totalmem() / 1024 ** 2) };
const results: Array<{ iteration: number; status: 'passed' | 'failed'; proofDirectory?: string }> = [];
for (let iteration = 1; iteration <= runs; iteration++) {
  let output = '';
  let proofDirectory: string | undefined;
  try {
    const completed = await promisify(execFile)(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'testing/local-runtime/smoke.ts'], {
      env: { ...process.env, RAT_NATIVE_VM_PROOF: '1', RAT_NATIVE_PROOF_CPUS: String(cpuCount) }, timeout: 240_000, maxBuffer: 1024 ** 2,
    });
    output = completed.stdout + completed.stderr;
    proofDirectory = /^Native VM evidence: (.+)$/m.exec(completed.stdout)?.[1];
    assert(proofDirectory, 'Smoke did not identify its proof directory');
    const proof = JSON.parse(await readFile(join(proofDirectory, 'result.json'), 'utf8')) as { boots: Array<{ cpuCount: number }>; inference: string };
    assert.equal(proof.inference, 'fixture');
    assert.equal(proof.boots.length, 3);
    assert(proof.boots.every(boot => boot.cpuCount === cpuCount), 'Proof used a different CPU count');
    results.push({ iteration, status: 'passed', proofDirectory });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stdout' in error) output = String(error.stdout) + ('stderr' in error ? String(error.stderr) : '');
    if (!output && error instanceof Error) output = error.message;
    proofDirectory ??= /^Native VM evidence: (.+)$/m.exec(output)?.[1];
    results.push({ iteration, status: 'failed', ...(proofDirectory ? { proofDirectory } : {}) });
    process.exitCode = 1;
  }
  await writeFile(join(directory, `run-${iteration}.log`), output, { mode: 0o600 });
  await writeFile(join(directory, 'result.json'), JSON.stringify({ cpuCount, requestedRuns: runs, image, host, results,
    scope: 'Sequential fixture journeys; no live subscription or abrupt recovery acceptance' }, null, 2), { mode: 0o600 });
  console.log(`Native reliability run ${iteration}/${runs}: ${results.at(-1)!.status}`);
  if (process.exitCode) break;
}
console.log(`Reliability evidence: ${directory}`);
