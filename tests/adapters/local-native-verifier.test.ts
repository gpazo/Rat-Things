import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import hostCodePolicy from '../../runtime/native/host-code-policy.json' with { type: 'json' };
import { LocalNativeBundleVerifier, NATIVE_VERIFIER_LIMITS } from '../../src/adapters/local-native-verifier.js';

const directories: string[] = [];
const executablePaths = hostCodePolicy.map(policy => policy.path);
const receipt = (manifest = Buffer.from([0, 255, 128, 13, 10])) => ({
  schemaVersion: 1, kind: 'authenticated', manifestBase64: manifest.toString('base64'), executablePaths,
});
const unavailable = (reason: string) => ({ kind: 'rejected', failure: { kind: 'verifier_unavailable', reason } });
const response = (value: unknown, code = 0) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode = ${code};`;

async function fixture(source = response(receipt()), deadlineMs?: number) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rat-native-signature-adapter-')));
  directories.push(directory);
  const bundlePath = join(directory, 'Runtime.bundle');
  const executable = join(directory, 'trusted-verifier');
  await mkdir(bundlePath);
  await writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return {
    directory, bundlePath, executable,
    verifier: new LocalNativeBundleVerifier({ trustedExecutable: executable, ...(deadlineMs === undefined ? {} : { deadlineMs }) }),
    input: { bundlePath, limits: NATIVE_VERIFIER_LIMITS },
  };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('trusted native verifier subprocess boundary', () => {
  it('returns exact authenticated bytes and every independently validated executable', async () => {
    const test = await fixture();
    expect(await test.verifier.verify(test.input)).toEqual({ kind: 'authenticated', manifestBytes: Buffer.from([0, 255, 128, 13, 10]), executablePaths });
  });

  it('returns empty authenticated bytes for the installer to reject as a manifest', async () => {
    const test = await fixture(response(receipt(Buffer.alloc(0))));
    expect(await test.verifier.verify(test.input)).toEqual({ kind: 'authenticated', manifestBytes: Buffer.alloc(0), executablePaths });
  });

  it('rejects a successful receipt that omits a pinned dylib or adds an unreviewed executable', async () => {
    const dylib = executablePaths.find(path => path.endsWith('.dylib'))!;
    for (const paths of [executablePaths.filter(path => path !== dylib), [...executablePaths, 'Contents/Resources/codex/codex-resources/zsh/bin/zsh']]) {
      const test = await fixture(response({ ...receipt(), executablePaths: paths }));
      expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier returned an invalid response'));
    }
  });

  it('uses fixed arguments, clamps production ceilings and clears ambient environment', async () => {
    const test = await fixture();
    const observation = join(test.directory, 'arguments.json');
    await writeFile(test.executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() })); ${response(receipt())}\n`);
    const oversized = Object.fromEntries(Object.keys(NATIVE_VERIFIER_LIMITS).map(key => [key, Number.MAX_SAFE_INTEGER])) as unknown as typeof NATIVE_VERIFIER_LIMITS;
    expect((await test.verifier.verify({ ...test.input, limits: oversized })).kind).toBe('authenticated');
    const { env, ...observed } = JSON.parse(await readFile(observation, 'utf8'));
    expect(Object.keys(env).filter(name => name !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
    expect(observed).toEqual({
      args: ['verify-runtime', test.bundlePath, '4096', '805306368', '2147483648', '131072', '32', '1024'], cwd: '/',
    });
  });

  it.each(['unsigned', 'ad_hoc', 'wrong_team', 'wrong_identifier', 'invalid'])('returns only fixed signature failure fields for %s', async reason => {
    const failure = { kind: 'signature', scope: 'executable', reason, path: executablePaths[0], osStatus: -67050 };
    const test = await fixture(response({ schemaVersion: 1, kind: 'rejected', stage: 'executable-signature', failure: { ...failure, detail: 'untrusted diagnostic' } }, 1));
    expect(await test.verifier.verify(test.input)).toEqual({ kind: 'rejected', failure });
  });

  it.each([
    { ...receipt(), schemaVersion: 2 }, { ...receipt(), manifestBase64: '***=' },
    { ...receipt(), manifestBase64: 'Zh==' },
    { ...receipt(), executablePaths: executablePaths.slice(1) },
    { ...receipt(), executablePaths: [executablePaths[0], ...executablePaths.slice(0, 4)] },
    { ...receipt(), executablePaths: [...executablePaths.slice(0, 4), 'Contents/Helpers/evil'] },
    { schemaVersion: 1, kind: 'rejected', stage: 'filesystem', failure: { kind: 'signature', scope: 'bundle', reason: 'secret path' } },
  ])('rejects malformed or incomplete wire receipts without copying their contents', async value => {
    const test = await fixture(response(value));
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier returned an invalid response'));
  });

  it.each([
    `process.stdout.write('not JSON');`,
    `process.stdout.write(Buffer.from([0xff]));`,
    response(receipt(), 1), response(receipt(), 2),
    response({ schemaVersion: 1, kind: 'rejected', stage: 'filesystem', failure: { kind: 'signature', scope: 'bundle', reason: 'invalid', path: '/private/secret' } }, 1),
    response({ schemaVersion: 1, kind: 'rejected', stage: 'unknown', failure: { kind: 'signature', scope: 'bundle', reason: 'invalid' } }, 1),
    response({ schemaVersion: 1, kind: 'rejected', stage: 'bundle-signature', failure: { kind: 'signature', scope: 'bundle', reason: 'invalid', osStatus: 2 ** 32 } }, 1),
  ])('fails closed on invalid JSON, encoding, status or failure schema', async source => {
    const test = await fixture(source);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier returned an invalid response'));
  });

  it('bounds decoded manifest length before accepting bytes', async () => {
    const test = await fixture(response(receipt(Buffer.from('1234'))));
    expect(await test.verifier.verify({ ...test.input, limits: { ...NATIVE_VERIFIER_LIMITS, manifestBytes: 3 } }))
      .toEqual(unavailable('Runtime verifier returned an invalid response'));
  });

  it.each(['stdout', 'stderr'])('kills and reaps a verifier that exceeds the %s bound', async stream => {
    const test = await fixture(`process.${stream}.write('x'.repeat(300000)); setInterval(() => {}, 1000);`);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier output exceeds its limit'));
  });

  it('kills and reaps a verifier at the deadline', async () => {
    const test = await fixture(undefined, 200);
    const pidFile = join(test.directory, 'pid');
    await writeFile(test.executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verification timed out'));
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports an unavailable binary without returning paths or operating system errors', async () => {
    const test = await fixture();
    await rm(test.executable);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier or candidate bundle is unavailable'));
  });

  it('reaps a process spawn failure', async () => {
    const test = await fixture();
    await writeFile(test.executable, '#!/missing-runtime-verifier-interpreter\n');
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier could not be started'));
  });

  it('refuses a verifier in the candidate, including an outside symlink pointing inside', async () => {
    const test = await fixture();
    const inside = join(test.bundlePath, 'verify');
    await writeFile(inside, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await rm(test.executable);
    await symlink(inside, test.executable);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier must be a trusted executable outside the candidate bundle'));
    const directlyInside = new LocalNativeBundleVerifier({ trustedExecutable: inside });
    expect(await directlyInside.verify(test.input)).toEqual(unavailable('Runtime verifier must be a trusted executable outside the candidate bundle'));
  });

  it('rejects nonexecutable verifier paths before launching', async () => {
    const test = await fixture();
    await chmod(test.executable, 0o600);
    expect(await test.verifier.verify(test.input)).toEqual(unavailable('Runtime verifier must be a trusted executable outside the candidate bundle'));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.1])('rejects invalid verifier limits %s', async entries => {
    const test = await fixture();
    expect(await test.verifier.verify({ ...test.input, limits: { ...NATIVE_VERIFIER_LIMITS, entries } }))
      .toEqual(unavailable('Runtime verifier input is invalid'));
  });

  it.each(['Runtime.bundle', '/tmp/../Runtime.bundle', '/tmp/Runtime.bundle\0', '/tmp/Runtime.bundle/'])('rejects unsafe input paths', async bundlePath => {
    const test = await fixture();
    expect(await test.verifier.verify({ ...test.input, bundlePath })).toEqual(unavailable('Runtime verifier input is invalid'));
  });

  it('rejects invalid trusted executable configuration', () => {
    expect(() => new LocalNativeBundleVerifier({ trustedExecutable: 'relative' })).toThrow('absolute trusted executable');
    expect(() => new LocalNativeBundleVerifier({ trustedExecutable: '/trusted', deadlineMs: 0 })).toThrow('positive deadline');
  });
});
