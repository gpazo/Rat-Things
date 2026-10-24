import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const BASE_IMAGE = 'public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:c07ab0773eddf9449c0994a87d8148300db98bdf8d8dad672a9dc26321c104fc';
export const RPM_RELEASE = '2023.12.20261016';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const imageDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const path = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/')
  && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => !part || part === '.' || part === '..');

export function parseArguments(arguments_) {
  const [command, ...argumentsRest] = arguments_;
  if (!['record-candidate', 'build'].includes(command)) throw new Error('Use record-candidate or build.');
  const options = {};
  const allowed = new Set(['guest-artifact', 'output', 'source-date-epoch', 'definition-root', 'lock', 'kernel-input-directory']);
  for (let index = 0; index < argumentsRest.length; index += 2) {
    const name = argumentsRest[index]?.slice(2);
    const value = argumentsRest[index + 1];
    if (!argumentsRest[index]?.startsWith('--') || !allowed.has(name) || name in options || !value || value.startsWith('--')) {
      throw new Error('Native guest build options must be explicit, unique name/value pairs.');
    }
    options[name] = value;
  }
  if (!options['guest-artifact'] || !options.output || !/^\d+$/.test(options['source-date-epoch'] ?? '')) {
    throw new Error('Explicit --guest-artifact, --output, and --source-date-epoch are required.');
  }
  const sourceDateEpoch = Number(options['source-date-epoch']);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0 || sourceDateEpoch > 0xFFFFFFFF) throw new Error('Source date epoch exceeds newc limits.');
  if (command === 'build' && !options.lock) throw new Error('A checked --lock is required for an ordinary native guest build.');
  if (command === 'record-candidate' && options.lock) throw new Error('Candidate capture does not accept a checked lock.');
  return { command, guestArtifact: options['guest-artifact'], output: options.output, sourceDateEpoch,
    definitionRoot: options['definition-root'], lock: options.lock, kernelInputDirectory: options['kernel-input-directory'] };
}

export function extractKernel(bytes, inputs) {
  if (bytes.length < 16 || bytes.length > inputs.vmlinuz.maximumBytes || digest(bytes) !== inputs.vmlinuz.sha256) throw new Error('Kernel input checksum or size differs from its lock.');
  const offset = bytes.readUInt32LE(8);
  const length = bytes.readUInt32LE(12);
  if (offset < 16 || length === 0 || offset + length > bytes.length) throw new Error('Kernel compressed payload exceeds its input bounds.');
  const kernel = gunzipSync(bytes.subarray(offset, offset + length), { maxOutputLength: inputs.image.maximumBytes });
  if (kernel.length < 64 || kernel.toString('ascii', 56, 60) !== 'ARMd'
    || kernel.readBigUInt64LE(16) < 64n || kernel.readBigUInt64LE(16) > BigInt(inputs.image.maximumBytes)
    || digest(kernel) !== inputs.image.sha256) {
    throw new Error('Extracted kernel is not the locked ARM64 Image.');
  }
  return kernel;
}

export function validatePackageInventory(value) {
  const fields = ['name', 'epoch', 'version', 'release', 'architecture', 'sourceRpm', 'license'];
  const validPackage = item => item && fields.every(field => typeof item[field] === 'string' && item[field].length > 0 && item[field] !== '(none)')
    && /^\d+$/.test(item.epoch) && ['aarch64', 'noarch'].includes(item.architecture) && item.name !== 'gpg-pubkey';
  if (value?.schemaVersion !== 1 || value.releasever !== RPM_RELEASE || !isDeepStrictEqual(value.enabledRepositories, ['amazonlinux'])
    || !Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 2000
    || !value.packages.every(validPackage)
    || !Array.isArray(value.beforePackages) || !value.beforePackages.every(validPackage)
    || new Set(value.packages.map(item => fields.slice(0, 5).map(field => item[field]).join('\0'))).size !== value.packages.length
    || !Array.isArray(value.keyFingerprints) || value.keyFingerprints.length === 0
    || !value.keyFingerprints.every(item => /^[a-f0-9]{40}$/.test(item)) || !sha256(value.importedKeysSha256)
    || !Array.isArray(value.repositoryFiles) || !value.repositoryFiles.some(item => typeof item.path === 'string' && item.path.endsWith('/repomd.xml') && item.bytes > 0)
    || !value.repositoryFiles.every(item => path(item.path) && sha256(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes >= 0)
    || !Array.isArray(value.cachedRpms) || !value.cachedRpms.every(item => path(item.filename) && !item.filename.includes('/')
      && sha256(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && validPackage(item.package)
      && value.packages.some(installed => isDeepStrictEqual(installed, item.package))
      && Array.isArray(item.signatures) && item.signatures.length > 0
      && item.signatures.every(signature => /signature.*: OK$/i.test(signature)))) {
    throw new Error('Incomplete RPM inventory, repository evidence, or signature checks.');
  }
  if (value.packages.some(item => !value.beforePackages.some(before => isDeepStrictEqual(before, item))
    && !value.cachedRpms.some(cached => isDeepStrictEqual(cached.package, item)))) throw new Error('Installed transaction package has no checked cached RPM.');
  return value;
}

export function validateGuestInputs(inputs) {
  if (!inputs || inputs.base?.reference !== BASE_IMAGE || !imageDigest(inputs.base.arm64ManifestDigest)
    || !imageDigest(inputs.base.configDigest) || !sha256(inputs.kernelInputsSha256)
    || !sha256(inputs.codexArtifactSha256) || !Number.isSafeInteger(inputs.sourceDateEpoch)
    || inputs.sourceDateEpoch < 0 || inputs.sourceDateEpoch > 0xFFFFFFFF || !Array.isArray(inputs.sources)
    || inputs.sources.length === 0 || !inputs.sources.every(item => path(item.path) && sha256(item.sha256))
    || new Set(inputs.sources.map(item => item.path)).size !== inputs.sources.length
    || !sha256(inputs.bundles?.workerSha256) || !sha256(inputs.bundles?.workspaceExportSha256)
    || !sha256(inputs.kernelModulesSha256) || !sha256(inputs.javascriptNoticesSha256)) throw new Error('Native guest lock inputs are incomplete.');
  validatePackageInventory(inputs.transactions?.worker);
  validatePackageInventory(inputs.transactions?.native);
  if (!isDeepStrictEqual(inputs.transactions.native.beforePackages, inputs.transactions.worker.packages)) throw new Error('Native RPM transaction did not extend the recorded worker packages.');
  return inputs;
}

export function requireCheckedLock(lock) {
  if (lock?.schemaVersion !== 1 || lock.status !== 'checked') throw new Error('The native guest input lock has not been checked. Capture and review a candidate first.');
  validateGuestInputs(lock.inputs);
  return lock;
}

export function compareGuestInputs(lock, actual) {
  requireCheckedLock(lock);
  validateGuestInputs(actual);
  const differences = Object.keys(actual).filter(key => !isDeepStrictEqual(lock.inputs[key], actual[key]));
  const missing = Object.keys(lock.inputs).filter(key => !(key in actual));
  if (differences.length || missing.length) throw new Error(`Native guest inputs differ from the checked lock: ${[...differences, ...missing].join(', ')}.`);
}
