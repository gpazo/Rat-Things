import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseTrace, provenance } from '../../testing/time-travel/artifacts.js';
import { hash, type Trace } from '../../testing/time-travel/model.js';
import { branch } from '../../testing/time-travel/simulator.js';

const directory = mkdtempSync(join(tmpdir(), 'rat-command-sim-'));
const demoDirectory = join(directory, 'demo');
const cli = resolve('testing/time-travel/cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args, '--json'], { encoding: 'utf8', timeout: 30_000 });
let original: Trace;
beforeAll(() => {
  const output = execFileSync('npm', ['run', '--silent', 'sim:commands', '--', 'demo', '--out', demoDirectory, '--json'], { encoding: 'utf8', timeout: 30_000 });
  expect(JSON.parse(output).checks).toEqual({ lostAckAndCrash: true, deadline: true, staleTarget: true, tamperRejected: true });
  original = JSON.parse(readFileSync(join(demoDirectory, 'original.json'), 'utf8')) as Trace;
}, 30_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('command simulator CLI', () => {
  it('runs the self-checking demo and saves a report backed by actual traces', () => {
    const summary = JSON.parse(readFileSync(join(demoDirectory, 'summary.json'), 'utf8'));
    expect(summary.search).toMatchObject({ seed: 17, runs: 2 });
    expect(summary.minimization.transformations).toContain('remove actor c');
    expect(summary.correct.freshSearch.runs).toBe(100);
    expect(original.result.effects).toBe(2);
    const report = readFileSync(join(demoDirectory, 'index.html'), 'utf8');
    expect(report).toContain('<link rel="stylesheet" href="brand.css">');
    expect(report).toContain(original.events.at(-1)!.worldHash);
    expect(report).toContain('Effects applied: ');
    expect(readFileSync(join(demoDirectory, 'brand.css'), 'utf8')).toBe(readFileSync('site/brand.css', 'utf8'));
  });
  it('replays, inspects, branches at an exact choice, and minimizes without rewriting the original', () => {
    const path = join(demoDirectory, 'original.json'); const bytes = readFileSync(path, 'utf8');
    const replayed = run('replay', path); expect(replayed.status, replayed.stderr).toBe(0); expect(JSON.parse(replayed.stdout).world.effects).toHaveLength(2);
    const inspected = run('inspect', path, '--at', '1'); expect(inspected.status, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).enabled).toContainEqual({ kind: 'crash', actor: 'c' });
    const childPath = join(directory, 'branch.json');
    const branched = run('branch', path, '--at', '1', '--choice', '{"kind":"crash","actor":"c"}', '--seed', '91', '--out', childPath);
    expect(branched.status, branched.stderr).toBe(0);
    const child = JSON.parse(readFileSync(childPath, 'utf8')) as Trace;
    expect(child.events[0]).toEqual(original.events[0]); expect(child.events[1]?.choice).toEqual({ kind: 'crash', actor: 'c' }); expect(child.parent?.digest).toBe(hash(original));
    const verified = run('replay', childPath, '--parent', path); expect(verified.status, verified.stderr).toBe(0);
    expect(run('replay', childPath).status).toBe(1);
    const minimized = run('minimize', path, '--attempts', '100', '--out', join(directory, 'min.json'));
    expect(minimized.status, minimized.stderr).toBe(0); expect(JSON.parse(minimized.stdout).minimizedSteps).toBeLessThan(original.events.length);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    const again = run('branch', path, '--at', '1', '--out', childPath); expect(again.status).toBe(1); expect(again.stderr).toContain('EEXIST');
  }, 30_000);
  it('explores bounded schedules and refuses existing output directories', () => {
    const out = join(directory, 'search'); const result = run('explore', '--seed', '23', '--runs', '3', '--steps', '40', '--out', out);
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).runs).toBe(3);
    const bytes = readFileSync(join(out, 'last.json'), 'utf8');
    expect(run('explore', '--runs', '1', '--out', out).status).toBe(1);
    expect(readFileSync(join(out, 'last.json'), 'utf8')).toBe(bytes);
  });
  it.each([
    ['explore', '--seed', '0'], ['explore', '--runs', '1001'], ['explore', '--runs', '1.5'], ['explore', '--runs'],
    ['explore', '--unknown', '1'], ['explore', '--seed', '1', '--seed', '2'], ['replay'], ['inspect', 'missing', '--at', '-1'],
  ])('rejects invalid arguments %j', (...args: string[]) => { const result = run(...args); expect(result.status).toBe(1); expect(JSON.parse(result.stderr).error).toBeTypeOf('string'); });
  it('rejects disabled branch choices without creating an output artifact', () => {
    const out = join(directory, 'disabled.json');
    const result = run('branch', join(demoDirectory, 'original.json'), '--at', '1', '--choice', '{"kind":"resume","actor":"a"}', '--out', out);
    expect(result.status).toBe(1); expect(result.stderr).toContain('Illegal choice'); expect(existsSync(out)).toBe(false);
  });
  it('rejects malformed input, tampering, provenance mismatch, and out-of-range inspection', () => {
    const malformed = join(directory, 'malformed.json'); writeFileSync(malformed, '{'); expect(run('replay', malformed).stderr).toContain('valid JSON');
    const tampered = structuredClone(original); tampered.events[0]!.world.now = 99; const path = join(directory, 'tampered.json'); writeFileSync(path, JSON.stringify(tampered)); expect(run('replay', path).stderr).toContain('integrity');
    const mismatch = structuredClone(original); mismatch.provenance.runtime.node = 'changed'; writeFileSync(path, JSON.stringify(mismatch)); expect(run('replay', path).stderr).toContain('provenance mismatch');
    const outOfRange = run('inspect', join(demoDirectory, 'original.json'), '--at', '999'); expect(outOfRange.status).toBe(1); expect(outOfRange.stderr).toContain('between');
  });
  it('requires strict enum scalars and bounded parent fields at the artifact boundary', async () => {
    const invalid = structuredClone(original) as unknown as { fixture: { faultModel: unknown }; parent?: unknown };
    invalid.fixture.faultModel = ['correct']; expect(() => parseTrace(invalid)).toThrow('fixture bounds');
    for (const at of [-1, 0.5, 9999]) expect(() => parseTrace({ ...original, parent: { digest: '0'.repeat(64), prefixHash: '0'.repeat(64), at } })).toThrow('parent proof');
    const altered = structuredClone(original) as unknown as { events: { choice: unknown }[] };
    altered.events[1]!.choice = { kind: 'apply', op: 'c:1', result: ['normal'] }; expect(() => parseTrace(altered)).toThrow('apply result');
    await expect(branch(original, await provenance(), { at: original.events.length, steps: 2000, seed: 1 })).rejects.toThrow('total step limit');
  });
});
