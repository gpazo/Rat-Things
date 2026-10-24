import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { BASE_IMAGE, RPM_RELEASE, compareGuestInputs, digest, extractKernel, parseArguments, requireCheckedLock, validatePackageInventory } from '../../scripts/native-guest-inputs.mjs';

const hash = 'a'.repeat(64);
const rpm = { name: 'example', epoch: '0', version: '1.2', release: '3.amzn2023', architecture: 'aarch64', sourceRpm: 'example-1.2-3.amzn2023.src.rpm', license: 'MIT' };
const packageInventory = () => ({ schemaVersion: 1, releasever: RPM_RELEASE, enabledRepositories: ['amazonlinux'], beforePackages: [] as typeof rpm[], packages: [{ ...rpm }],
  cachedRpms: [{ filename: 'example.rpm', bytes: 123, sha256: hash, package: { ...rpm }, signatures: ['Header V4 RSA/SHA256 Signature, key ID 12345678: OK'] }],
  keyFingerprints: ['b'.repeat(40)], importedKeysSha256: hash,
  repositoryFiles: [{ path: 'var/cache/dnf/amazonlinux-example/repodata/repomd.xml', bytes: 10, sha256: hash }] });
const inputs = () => ({ base: { reference: BASE_IMAGE, arm64ManifestDigest: `sha256:${hash}`, configDigest: `sha256:${hash}` },
  sourceDateEpoch: 1_790_000_000, kernelInputsSha256: hash, codexArtifactSha256: hash, kernelModulesSha256: hash, javascriptNoticesSha256: hash,
  bundles: { workerSha256: hash, workspaceExportSha256: hash },
  sources: [{ path: 'runtime/native/guest.py', sha256: hash }], transactions: { worker: packageInventory(), native: { ...packageInventory(), beforePackages: [{ ...rpm }] } } });

it('exports normalized fixture archives and records a signed fake RPM inventory without Docker', async () => {
  await expect(promisify(execFile)('python3', ['testing/local-runtime/test_native_build.py'], { timeout: 15_000 })).resolves.toMatchObject({ stdout: '' });
});

it('requires explicit guest artifact, source epoch, and a checked lock for build', () => {
  expect(() => parseArguments(['build', '--output', '/tmp/new'])).toThrow('Explicit');
  expect(() => parseArguments(['build', '--guest-artifact', '/artifact', '--output', '/tmp/new', '--source-date-epoch', '1'])).toThrow('checked --lock');
  expect(parseArguments(['record-candidate', '--guest-artifact', '/artifact', '--output', '/tmp/new', '--source-date-epoch', '1'])).toMatchObject({ command: 'record-candidate', sourceDateEpoch: 1 });
  expect(() => parseArguments(['record-candidate', '--guest-artifact', '/artifact', '--output', '/tmp/new', '--source-date-epoch', '1', '--lock', '/lock'])).toThrow('does not accept');
  expect(() => parseArguments(['record-candidate', '--guest-artifact', '/artifact', '--output', '/tmp/new', '--source-date-epoch', '4294967296'])).toThrow('newc');
});

it('rejects an absent lock before discovering Docker or creating a build', async () => {
  await expect(promisify(execFile)(process.execPath, [resolve('scripts/build-native-guest.mjs'), 'build', '--guest-artifact', '/missing', '--output', '/missing', '--source-date-epoch', '1'], {
    env: { ...process.env, PATH: '/nonexistent', CODEX_RUNTIME_ARTIFACT: '/ambient-must-not-be-used', RAT_NATIVE_SOURCE_IMAGE: 'proof-must-not-be-used' }, timeout: 10_000,
  })).rejects.toThrow('checked --lock');
});

it('never promotes captured candidate data into a checked lock', () => {
  expect(() => requireCheckedLock({ schemaVersion: 1, status: 'candidate', inputs: inputs() })).toThrow('not been checked');
  const lock = { schemaVersion: 1, status: 'checked', inputs: inputs() };
  expect(() => compareGuestInputs(lock, structuredClone(lock.inputs))).not.toThrow();
  expect(lock.status).toBe('checked');
});

it('requires and compares the exact JavaScript notice index hash in the guest lock', () => {
  const lock = { schemaVersion: 1, status: 'checked', inputs: inputs() };
  expect(() => requireCheckedLock({ ...lock, inputs: { ...inputs(), javascriptNoticesSha256: undefined } })).toThrow('incomplete');
  expect(() => compareGuestInputs(lock, { ...inputs(), javascriptNoticesSha256: 'c'.repeat(64) })).toThrow('javascriptNoticesSha256');
});

it.each(['packages', 'cachedRpms', 'repositoryFiles', 'keyFingerprints'] as const)('compares every observed %s entry against the checked lock', field => {
  const lock = { schemaVersion: 1, status: 'checked', inputs: inputs() };
  const actual = structuredClone(lock.inputs);
  if (field === 'packages') {
    actual.transactions.native.packages[0]!.license = 'GPL-2.0-only';
    actual.transactions.native.cachedRpms[0]!.package.license = 'GPL-2.0-only';
  } else if (field === 'cachedRpms') actual.transactions.native.cachedRpms[0]!.sha256 = 'c'.repeat(64);
  else if (field === 'repositoryFiles') actual.transactions.native.repositoryFiles[0]!.sha256 = 'c'.repeat(64);
  else actual.transactions.native.keyFingerprints[0] = 'c'.repeat(40);
  expect(() => compareGuestInputs(lock, actual)).toThrow('transactions');
});

it('rejects source drift and missing source RPM, license, or successful signatures', () => {
  const lock = { schemaVersion: 1, status: 'checked', inputs: inputs() };
  const actual = structuredClone(lock.inputs);
  actual.sources[0]!.sha256 = 'd'.repeat(64);
  expect(() => compareGuestInputs(lock, actual)).toThrow('sources');
  const inventory = packageInventory();
  inventory.packages[0]!.sourceRpm = '(none)';
  expect(() => validatePackageInventory(inventory)).toThrow('Incomplete RPM');
  inventory.packages[0]!.sourceRpm = rpm.sourceRpm;
  inventory.cachedRpms[0]!.signatures[0] = 'Header V4 RSA Signature: NOKEY';
  expect(() => validatePackageInventory(inventory)).toThrow('Incomplete RPM');
});

function kernelFixture() {
  const image = Buffer.alloc(128);
  image.writeBigUInt64LE(128n, 16);
  image.write('ARMd', 56);
  const compressed = gzipSync(image);
  const bytes = Buffer.concat([Buffer.alloc(64), compressed]);
  bytes.writeUInt32LE(64, 8);
  bytes.writeUInt32LE(compressed.length, 12);
  return { image, bytes, lock: { vmlinuz: { sha256: digest(bytes), maximumBytes: 1024 }, image: { sha256: digest(image), maximumBytes: 1024 } } };
}

it('extracts only the locked bounded ARM64 kernel payload', () => {
  const f = kernelFixture();
  expect(extractKernel(f.bytes, f.lock)).toEqual(f.image);
  f.bytes.writeUInt32LE(f.bytes.length + 1, 12);
  f.lock.vmlinuz.sha256 = digest(f.bytes);
  expect(() => extractKernel(f.bytes, f.lock)).toThrow('bounds');
});

it('rejects changed input, expanded output, non-ARM64 image, and changed extracted image', () => {
  const f = kernelFixture();
  expect(() => extractKernel(Buffer.concat([f.bytes, Buffer.from('x')]), f.lock)).toThrow('checksum');
  expect(() => extractKernel(f.bytes, { ...f.lock, image: { ...f.lock.image, maximumBytes: 100 } })).toThrow();
  expect(() => extractKernel(f.bytes, { ...f.lock, image: { ...f.lock.image, sha256: hash } })).toThrow('locked ARM64');
  f.image.write('nope', 56);
  const compressed = gzipSync(f.image);
  const bytes = Buffer.concat([f.bytes.subarray(0, 64), compressed]);
  bytes.writeUInt32LE(compressed.length, 12);
  expect(() => extractKernel(bytes, { vmlinuz: { sha256: digest(bytes), maximumBytes: 1024 }, image: { sha256: digest(f.image), maximumBytes: 1024 } })).toThrow('locked ARM64');
});
