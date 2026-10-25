import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import hostCodePolicy from '../runtime/native/host-code-policy.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';
import { compareGuestInputs, requireCheckedLock } from './native-guest-inputs.mjs';
import { requireJavaScriptNoticeIndex, verifyJavaScriptNoticeArchive } from './javascript-notices.mjs';
import { verifyGuestArchive } from './native-guest-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ordered = values => [...values].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const samePaths = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
const safeArchivePath = path => typeof path === 'string' && Buffer.byteLength(path) <= 1024 && path.normalize('NFC') === path
  && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').length <= 32
  && path.split('/').every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
const safePath = path => safeArchivePath(path) && !path.includes(':');
const hashPattern = /^[a-f0-9]{64}$/;
const manifestPath = 'Contents/Resources/runtime-manifest.json';
const signaturePaths = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'].map(path => `Contents/_CodeSignature/${path}`);
const limits = { entries: 4096, fileBytes: 768 * 1024 ** 2, totalBytes: 2 * 1024 ** 3, manifestBytes: 128 * 1024 };
const guestArtifacts = ['Image', 'worker-initramfs.gz', 'archive-inventory.json', 'worker-dependencies.json', 'worker-notices.json', 'worker-metafile.json', 'worker-build.json', 'build.log'];
const jitEntitlements = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'];
export const nativeExecutablePolicy = Object.freeze(hostCodePolicy.map(policy => Object.freeze(policy)));
const executables = new Map(nativeExecutablePolicy.map(value => [value.path, value]));

export function parseNativeReleaseOptions(args) {
  const options = {};
  const names = ['host-artifact', 'guest-output', 'definition-root', 'output', 'identity'];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !names.includes(name) || name in options || !value || value.startsWith('--')) {
      throw new Error('Native release options must be explicit, unique name/value pairs.');
    }
    options[name] = value;
  }
  if (names.some(name => !options[name])) throw new Error(`Required options: ${names.map(name => `--${name}`).join(', ')}.`);
  if (!/^Developer ID Application: [^\r\n]+ \(PB8NAVKU57\)$/.test(options.identity)) throw new Error('An explicit Developer ID Application identity for team PB8NAVKU57 is required.');
  return { hostArtifact: resolve(options['host-artifact']), guestOutput: resolve(options['guest-output']),
    definitionRoot: resolve(options['definition-root']), output: resolve(options.output), identity: options.identity };
}

const version = number => `${number >>> 16}.${(number >>> 8) & 255}.${number & 255}`;
function maximumVersion(versions) {
  return [...versions].sort((a, b) => {
    const left = a.split('.').map(Number); const right = b.split('.').map(Number);
    return (left[0] - right[0]) || ((left[1] ?? 0) - (right[1] ?? 0)) || ((left[2] ?? 0) - (right[2] ?? 0));
  }).at(-1);
}

export function inspectMachO(bytes, policy = { machOType: 2 }) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x100000c
    || ![2, 6].includes(policy.machOType) || bytes.readUInt32LE(12) !== policy.machOType) {
    throw new Error('Expected a thin ARM64 Mach-O matching the fixed host code policy.');
  }
  const count = bytes.readUInt32LE(16); const end = 32 + bytes.readUInt32LE(20);
  if (!count || count > 4096 || end > bytes.length) throw new Error('Mach-O load commands exceed their bounds.');
  const versions = []; const libraries = []; const rpaths = [];
  let offset = 32;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error('Truncated Mach-O load command.');
    const command = bytes.readUInt32LE(offset); const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 || offset + size > end) throw new Error('Invalid Mach-O load command bounds.');
    if (command === 0x32) {
      if (size < 24 || bytes.readUInt32LE(offset + 8) !== 1) throw new Error('Mach-O build platform is not macOS.');
      versions.push(version(bytes.readUInt32LE(offset + 12)));
    } else if (command === 0x24) {
      if (size < 16) throw new Error('Invalid macOS deployment command.');
      versions.push(version(bytes.readUInt32LE(offset + 8)));
    } else if ([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023, 0x8000001c].includes(command)) {
      const minimum = command === 0x8000001c ? 12 : 24;
      if (size < minimum) throw new Error('Invalid linked library command.');
      const start = offset + bytes.readUInt32LE(offset + 8); const terminator = bytes.indexOf(0, start);
      if (start < offset + minimum || start >= offset + size || terminator < start || terminator >= offset + size) throw new Error('Invalid linked library name.');
      const library = bytes.toString('utf8', start, terminator);
      if (command === 0x8000001c) rpaths.push(library);
      else libraries.push(library);
    }
    offset += size;
  }
  if (offset !== end || !versions.length || versions.some(value => Number(value.split('.')[0]) < 11)) throw new Error('Missing or inconsistent macOS deployment commands.');
  if (!isDeepStrictEqual(rpaths, policy.rpaths ?? [])) throw new Error('Mach-O search paths differ from the fixed host code policy.');
  for (const library of libraries) {
    const system = (library.startsWith('/usr/lib/') || library.startsWith('/System/Library/')) && posix.normalize(library) === library;
    const local = name => policy.path && name.startsWith('@loader_path/')
      ? posix.normalize(posix.join(posix.dirname(policy.path), name.slice('@loader_path/'.length))) : undefined;
    const candidates = library.startsWith('@rpath/')
      ? rpaths.map(path => local(`${path}/${library.slice('@rpath/'.length)}`)) : [local(library)];
    if (!system && !candidates.some(path => executables.get(path)?.machOType === 6)) {
      throw new Error(`Runtime code requires an unbundled library: ${library}.`);
    }
  }
  return { minimumMacOS: maximumVersion(versions), libraries };
}

export function nativeCompatibility(protocol, machOs) {
  const fields = ['appProtocol', 'controllerProtocol', 'workerProtocol', 'workspaceFormat', 'accountStateFormat', 'profileSchema'];
  if (protocol?.hostTarget !== 'aarch64-apple-darwin' || protocol.guestTarget !== 'aarch64-unknown-linux-gnu'
    || fields.some(field => !Number.isSafeInteger(protocol[field]) || protocol[field] < 1) || machOs.length !== nativeExecutablePolicy.length) {
    throw new Error('Native protocol definition or built executable deployment evidence is incomplete.');
  }
  return { hostTarget: protocol.hostTarget, guestTarget: protocol.guestTarget, minimumMacOS: maximumVersion(machOs.map(value => value.minimumMacOS)),
    appProtocol: { minimum: protocol.appProtocol, maximum: protocol.appProtocol },
    controllerProtocol: { minimum: protocol.controllerProtocol, maximum: protocol.controllerProtocol }, workerProtocol: protocol.workerProtocol,
    workspaceFormat: { read: [protocol.workspaceFormat], write: protocol.workspaceFormat }, accountStateFormat: protocol.accountStateFormat, profileSchema: protocol.profileSchema };
}

export function signingArguments(identity, policy, filename, entitlementPaths) {
  return ['--force', '--sign', identity, '--identifier', policy.identifier, '--options', 'runtime', '--timestamp',
    ...(policy.entitlements ? ['--entitlements', entitlementPaths[policy.entitlements]] : []), filename];
}

function requirement(identifier) {
  return `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "PB8NAVKU57"`;
}

const fileIdentity = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].map(String).join(':');
/** @param {string} filename
 * @param {{ expected?: { sha256: string, bytes?: number }, destination?: string, mode?: number, capture?: boolean, maximumBytes?: number }} options */
export async function checkedFile(filename, { expected, destination, mode = 0o444, capture = false, maximumBytes = limits.fileBytes } = {}) {
  const source = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error(`Input is linked, special, or exceeds its byte limit: ${filename}.`);
    if (destination) {
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      output = await open(destination, 'wx', 0o600);
    }
    const hash = createHash('sha256'); const chunks = []; let size = 0;
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error(`Input exceeds its byte limit: ${filename}.`);
      hash.update(chunk);
      if (capture) chunks.push(chunk);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset)).bytesWritten;
      }
    }
    const sha256 = hash.digest('hex');
    if (fileIdentity(before) !== fileIdentity(await source.stat({ bigint: true })) || BigInt(size) !== before.size
      || (expected && (sha256 !== expected.sha256 || (expected.bytes !== undefined && size !== expected.bytes)))) throw new Error(`Input changed or checksum differs: ${filename}.`);
    if (output) await output.chmod(mode);
    return { bytes: size, sha256, ...(capture ? { data: Buffer.concat(chunks) } : {}) };
  } finally { await output?.close(); await source.close(); }
}

export async function nativeBundleInventory(bundle) {
  const files = []; const aliases = new Set(); let entries = 0; let total = 0;
  async function visit(directory, prefix) {
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error('Bundle directories must not be symlinks.');
    const children = await readdir(directory, { withFileTypes: true });
    if (!children.length) throw new Error('Bundle contains an empty directory.');
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (!safePath(path) || (path !== 'Contents' && !path.startsWith('Contents/')) || aliases.has(path.toLowerCase())) throw new Error('Invalid or case-aliased bundle path.');
      aliases.add(path.toLowerCase());
      if (++entries > limits.entries) throw new Error('Bundle exceeds its entry limit.');
      if (child.isDirectory()) await visit(join(directory, child.name), path);
      else if (child.isFile()) {
        const filename = join(bundle, path); const info = await lstat(filename);
        const file = await checkedFile(filename, { maximumBytes: path === manifestPath ? limits.manifestBytes : limits.fileBytes });
        total += file.bytes;
        if (total > limits.totalBytes) throw new Error('Bundle exceeds its total byte limit.');
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); const header = Buffer.alloc(4);
        try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
        const machO = ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'));
        const executable = executables.get(path);
        if (Boolean(info.mode & 0o111) !== Boolean(executable) || machO !== Boolean(executable)) throw new Error(`Unexpected executable or executable format: ${path}.`);
        files.push({ path, ...file, ...(executable ? { kind: 'host-executable', role: executable.role } : { kind: 'resource' }) });
      } else throw new Error(`Bundle contains a symlink or special file: ${path}.`);
    }
  }
  await visit(bundle, '');
  return ordered(files);
}

export function nativeManifest(version, compatibility, inventory, expectedPaths) {
  const payload = inventory.filter(file => file.path !== manifestPath && !signaturePaths.includes(file.path));
  if (!samePaths(payload.map(file => file.path), expectedPaths) || nativeExecutablePolicy.some(policy => !payload.some(file => file.path === policy.path))) {
    throw new Error('Bundle payload differs from the exact assembly inventory.');
  }
  const bytes = jsonBytes({ schemaVersion: 1, version, compatibility, files: ordered(payload) });
  if (bytes.length > limits.manifestBytes) throw new Error('Runtime manifest exceeds its byte limit.');
  return { bytes, releaseId: digest(bytes) };
}

export function nativeBundleFingerprint(inventory) {
  const files = [...inventory].sort((a, b) => {
    const left = a.path.split('/'); const right = b.path.split('/');
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return left.length - right.length;
  });
  return digest(files.map(file => `${file.path}\0${file.bytes}\0${file.kind === 'host-executable'}\0${file.sha256}\n`).join(''));
}

async function guestEvidence(directory, readInput, host, companions) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Guest output must be a regular directory.');
  const readJson = async name => JSON.parse((await readInput(join(directory, name), `guest/${name}`)).data);
  const build = await readJson('guest-build.json'); const lock = requireCheckedLock(await readJson('checked-lock.json'));
  const inputs = await readJson('observed-inputs.json'); compareGuestInputs(lock, inputs);
  for (const stage of ['worker', 'native']) {
    if (!isDeepStrictEqual(await readJson(`evidence/${stage}/inventory.json`), inputs.transactions[stage])) throw new Error('Guest package evidence differs from the checked lock.');
  }
  const modules = await readInput(join(directory, 'evidence/kernel.json'), 'guest/evidence/kernel.json');
  if (modules.sha256 !== inputs.kernelModulesSha256) throw new Error('Guest kernel module evidence differs from the checked lock.');
  if (build.schemaVersion !== 1 || build.status !== 'inputs-checked' || build.distributionReady !== false
    || build.lockSha256 !== (await checkedFile(join(directory, 'checked-lock.json'))).sha256
    || build.inputsSha256 !== (await checkedFile(join(directory, 'observed-inputs.json'))).sha256
    || build.sourceDateEpoch !== inputs.sourceDateEpoch || build.gzipMtime !== 0
    || !Array.isArray(build.outstandingDistributionInputs) || !build.outstandingDistributionInputs.every(value => typeof value === 'string' && value.length <= 1024)
    || !Array.isArray(build.artifacts) || !samePaths(build.artifacts.map(file => file.path), guestArtifacts)
    || new Set(build.artifacts.map(file => file.path)).size !== guestArtifacts.length) throw new Error('Guest output does not match its checked build evidence.');
  for (const file of build.artifacts) {
    if (!hashPattern.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new Error('Invalid guest artifact hash or size.');
    await readInput(join(directory, file.path), `guest/${file.path}`, { expected: file, capture: false, maximumBytes: limits.fileBytes });
  }
  const artifact = await readJson('evidence/codex-artifact.json');
  if (inputs.codexArtifactSha256 !== (await checkedFile(join(directory, 'evidence/codex-artifact.json'))).sha256
    || !isDeepStrictEqual(artifact.source, host.source) || artifact.platform !== 'linux' || artifact.arch !== 'arm64'
    || !isDeepStrictEqual(artifact.upstreamPackage, { name: '@openai/codex-linux-arm64', version: companions.version })
    || artifact.build?.patchedTree !== host.build.patchedTree || artifact.build.profile !== 'release' || artifact.build.debug !== 'none'
    || artifact.build.incremental !== false || artifact.build.locked !== true || !Number.isSafeInteger(artifact.build.jobs) || artifact.build.jobs < 1
    || artifact.build.nativeTarget !== 'aarch64-unknown-linux-gnu') throw new Error('Guest Codex evidence differs from the admitted release definition.');
  const archive = await readJson('archive-inventory.json');
  if (archive.format !== 'newc' || archive.sourceDateEpoch !== inputs.sourceDateEpoch || !Array.isArray(archive.entries)
    || archive.entries.length > 100_000 || !Number.isSafeInteger(archive.uncompressedBytes) || archive.uncompressedBytes > 1400 * 1024 ** 2
    || !archive.entries.every(entry => safeArchivePath(entry.path)) || new Set(archive.entries.map(entry => entry.path)).size !== archive.entries.length) throw new Error('Invalid guest archive inventory.');
  const dependencies = ordered(await readJson('worker-dependencies.json'));
  const noticeBytes = await readInput(join(directory, 'worker-notices.json'), 'guest/worker-notices.json');
  if (noticeBytes.sha256 !== inputs.javascriptNoticesSha256) throw new Error('Guest JavaScript notice index differs from its checked lock.');
  const javascriptNotices = requireJavaScriptNoticeIndex(JSON.parse(noticeBytes.data), { surface: 'worker', dependencies });
  verifyJavaScriptNoticeArchive(javascriptNotices, archive.entries, noticeBytes.sha256);
  const members = archive.entries.filter(entry => entry.path.startsWith('opt/codex-runtime/') && (entry.mode & 0o170000) !== 0o040000);
  const manifestFiles = artifact.files;
  const guestNotices = inputs.sources.filter(file => file.path.startsWith('runtime/codex/licenses/'));
  const supplementary = [{ path: 'artifact.json', sha256: inputs.codexArtifactSha256 }, ...guestNotices.map(file => ({ path: `licenses/${file.path.slice('runtime/codex/licenses/'.length)}`, sha256: file.sha256 }))];
  if (!Array.isArray(manifestFiles) || !samePaths(manifestFiles.map(file => file.path), companions.files.map(file => file.path))
    || !samePaths(members.map(entry => entry.path), [...manifestFiles, ...supplementary].map(file => `opt/codex-runtime/${file.path}`))) throw new Error('Guest Codex inventory is incomplete or unexpected.');
  for (const file of supplementary) {
    const member = members.find(entry => entry.path === `opt/codex-runtime/${file.path}`);
    if (member.sha256 !== file.sha256 || member.mode !== 0o100444) throw new Error(`Guest provenance or notice differs from its checked source: ${file.path}.`);
  }
  for (const file of manifestFiles) {
    const member = members.find(entry => entry.path === `opt/codex-runtime/${file.path}`); const companion = companions.files.find(entry => entry.path === file.path);
    const descriptor = { ...companions.descriptor, target: 'aarch64-unknown-linux-gnu' };
    const expected = file.path === 'bin/codex' ? artifact.sha256 : file.path === 'codex-package.json' ? digest(jsonBytes(descriptor)) : companion.sha256;
    if (file.sha256 !== expected || !hashPattern.test(file.sha256) || member.sha256 !== file.sha256
      || member.mode !== (0o100000 | (companion.executable ? 0o755 : 0o444))) throw new Error(`Guest Codex member differs from the admitted package: ${file.path}.`);
  }
  await verifyGuestArchive(join(directory, 'worker-initramfs.gz'), archive, build.artifacts.find(file => file.path === 'worker-initramfs.gz'));
  return { build, inputs, artifact, archive, dependencies, javascriptNotices, worker: await readJson('worker-build.json') };
}

const infoPlist = version => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.rat-things.runtime</string><key>CFBundlePackageType</key><string>BNDL</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`;
const entitlementPlist = keys => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>\n`;

export async function assembleNativeRelease(options, { repositoryRoot = root, run = async (command, args) => execute(command, args, { timeout: 180_000, maxBuffer: 4 * 1024 ** 2 }) } = {}) {
  const { hostArtifact, guestOutput, definitionRoot, output, identity } = options;
  const tracked = new Map(); const sources = [];
  const readInput = async (filename, label, settings = {}) => {
    const result = await checkedFile(filename, { capture: true, maximumBytes: 32 * 1024 ** 2, ...settings });
    tracked.set(filename, { bytes: result.bytes, sha256: result.sha256 });
    sources.push({ path: label, bytes: result.bytes, sha256: result.sha256 });
    return result;
  };
  const builderSources = ['runtime/native/host-code-policy.json', 'scripts/build-native-release.mjs', 'scripts/codex-runtime-artifact.mjs', 'scripts/codex-runtime-targets.mjs', 'scripts/native-guest-inputs.mjs', 'scripts/javascript-notices.mjs', 'scripts/native-build-files.mjs', 'scripts/native-guest-archive.mjs'];
  for (const path of builderSources) await readInput(join(root, path), path);
  const originalHost = await readInput(join(hostArtifact, 'artifact.json'), 'host/artifact.json');
  const sourceDefinition = JSON.parse((await readInput(join(definitionRoot, 'source.json'), 'definition/source.json')).data);
  await readInput(join(definitionRoot, 'artifact-policy.json'), 'definition/artifact-policy.json');
  for (const path of sourceDefinition.patches) {
    if (!safePath(path)) throw new Error('Invalid trusted patch path.');
    await readInput(join(definitionRoot, path), `definition/${path}`);
  }
  const companionInventoryPath = join(repositoryRoot, 'runtime/codex/companion-packages.json');
  const companions = JSON.parse((await readInput(companionInventoryPath, 'runtime/codex/companion-packages.json')).data);
  await readInput(join(repositoryRoot, 'package-lock.json'), 'package-lock.json');
  const admissionOptions = { expectedTarget: 'aarch64-apple-darwin', definitionRoot, packageLockPath: join(repositoryRoot, 'package-lock.json'), companionInventoryPath };
  const host = await validateCodexRuntimeArtifact(hostArtifact, admissionOptions);
  if (!isDeepStrictEqual(host.manifest, JSON.parse(originalHost.data))) throw new Error('Host manifest changed during admission.');
  const guest = await guestEvidence(guestOutput, readInput, host.manifest, companions['@openai/codex-linux-arm64']);
  const protocolInput = await readInput(join(repositoryRoot, 'runtime/native/protocol.json'), 'runtime/native/protocol.json');
  const protocol = JSON.parse(protocolInput.data);
  const helperSource = await readInput(join(repositoryRoot, 'runtime/native/main.swift'), 'runtime/native/main.swift');
  const helperEntitlements = await readInput(join(repositoryRoot, 'runtime/native/entitlements.plist'), 'runtime/native/entitlements.plist');
  if (!helperEntitlements.data.toString().includes('<key>com.apple.security.virtualization</key>')
    || [...helperEntitlements.data.toString().matchAll(/<key>/g)].length !== 1) throw new Error('Helper entitlement policy must contain only virtualization.');
  const kernelInput = await readInput(join(repositoryRoot, 'runtime/native/kernel-inputs.json'), 'runtime/native/kernel-inputs.json');
  const kernel = JSON.parse(kernelInput.data);
  if (guest.inputs.kernelInputsSha256 !== kernelInput.sha256 || guest.build.artifacts.find(file => file.path === 'Image').sha256 !== kernel.image.sha256) throw new Error('Guest kernel differs from the maintained kernel inputs.');
  const notices = await Promise.all(['LICENSE', 'NOTICE'].map(async name => ({ name, ...await readInput(join(repositoryRoot, 'runtime/codex/licenses', name), `runtime/codex/licenses/${name}`) })));
  for (const notice of notices) {
    if (guest.inputs.sources.find(file => file.path === `runtime/codex/licenses/${notice.name}`)?.sha256 !== notice.sha256) throw new Error('Guest Codex notices differ from the maintained notices.');
  }
  const firstParty = await readInput(join(repositoryRoot, 'LICENSE'), 'LICENSE');
  await mkdir(dirname(output), { recursive: true });
  const realParent = await realpath(dirname(output));
  const dist = join(await realpath(repositoryRoot), 'dist');
  if (realParent === dist || realParent.startsWith(dist + '/') || output === dist) throw new Error('Native release output must survive ordinary dist cleanup.');
  for (const input of [hostArtifact, guestOutput, definitionRoot]) {
    const directory = await realpath(input);
    if (realParent === directory || realParent.startsWith(directory + '/')) throw new Error('Release output must not be inside an input directory.');
  }
  await mkdir(output, { mode: 0o700 });
  const bundle = join(output, 'Runtime.bundle'); const evidence = join(output, 'evidence');
  await mkdir(evidence); await mkdir(join(bundle, 'Contents/Resources'), { recursive: true });
  const write = async (filename, bytes) => { await mkdir(dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o444 }); };
  const expectedPaths = []; const staged = new Map();
  const resource = async (path, bytes) => {
    await write(join(bundle, path), bytes); expectedPaths.push(path);
    staged.set(path, { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
  };
  try {
    await write(join(evidence, 'host-artifact.json'), originalHost.data);
    for (const path of ['source.json', 'artifact-policy.json', ...sourceDefinition.patches]) {
      await checkedFile(join(definitionRoot, path), { expected: tracked.get(join(definitionRoot, path)), destination: join(evidence, 'definition', path) });
    }
    for (const path of ['package-lock.json', 'runtime/codex/companion-packages.json']) {
      await checkedFile(join(repositoryRoot, path), { expected: tracked.get(join(repositoryRoot, path)), destination: join(evidence, 'build-inputs', path) });
    }
    for (const path of builderSources) {
      await checkedFile(join(root, path), { expected: tracked.get(join(root, path)), destination: join(evidence, 'build-inputs', path) });
    }
    for (const name of ['guest-build.json', 'checked-lock.json', 'observed-inputs.json', 'evidence/codex-artifact.json', 'evidence/kernel.json', 'evidence/worker/inventory.json', 'evidence/native/inventory.json', ...guestArtifacts.filter(path => !['Image', 'worker-initramfs.gz'].includes(path))]) {
      await checkedFile(join(guestOutput, name), { destination: join(evidence, 'guest', name), expected: tracked.get(join(guestOutput, name)), maximumBytes: limits.fileBytes });
    }
    await write(join(evidence, 'native-inputs/main.swift'), helperSource.data);
    await write(join(evidence, 'native-inputs/entitlements.plist'), helperEntitlements.data);
    await write(join(evidence, 'native-inputs/jit-entitlements.plist'), entitlementPlist(jitEntitlements));
    const machOs = []; const unsigned = [];
    for (const file of host.files) {
      const path = `Contents/Resources/codex/${file.path}`; expectedPaths.push(path);
      const copied = await checkedFile(file.source, { expected: file, destination: join(bundle, path), mode: file.mode, capture: executables.has(path) });
      tracked.set(file.source, { bytes: copied.bytes, sha256: copied.sha256 });
      if (!executables.has(path)) staged.set(path, { bytes: copied.bytes, sha256: copied.sha256 });
      if (executables.has(path)) { machOs.push({ path, ...inspectMachO(copied.data, executables.get(path)) }); unsigned.push({ path, bytes: copied.bytes, sha256: copied.sha256 }); }
    }
    for (const name of ['Image', 'worker-initramfs.gz']) {
      const path = `Contents/Resources/linux/${name}`; expectedPaths.push(path);
      const copied = await checkedFile(join(guestOutput, name), { expected: tracked.get(join(guestOutput, name)), destination: join(bundle, path) });
      staged.set(path, { bytes: copied.bytes, sha256: copied.sha256 });
    }
    const toolchain = {};
    for (const [name, args] of [['swift', ['swiftc', '--version']], ['sdkVersion', ['--sdk', 'macosx', '--show-sdk-version']], ['sdkBuild', ['--sdk', 'macosx', '--show-sdk-build-version']], ['sdkPath', ['--sdk', 'macosx', '--show-sdk-path']]]) {
      toolchain[name] = (await run('/usr/bin/xcrun', args)).stdout.trim();
    }
    const helperPath = nativeExecutablePolicy.find(policy => policy.role === 'vm-helper').path;
    const deploymentTarget = maximumVersion(['12.0', ...machOs.map(value => value.minimumMacOS)]);
    const compileArguments = ['swiftc', join(evidence, 'native-inputs/main.swift'), '-O', '-target', `arm64-apple-macos${deploymentTarget}`,
      '-sdk', toolchain.sdkPath, '-framework', 'Virtualization', '-o', join(bundle, helperPath)];
    await mkdir(dirname(join(bundle, helperPath)), { recursive: true });
    await run('/usr/bin/xcrun', compileArguments); await chmod(join(bundle, helperPath), 0o755); expectedPaths.push(helperPath);
    const helper = await checkedFile(join(bundle, helperPath), { capture: true });
    machOs.push({ path: helperPath, ...inspectMachO(helper.data) }); unsigned.push({ path: helperPath, bytes: helper.bytes, sha256: helper.sha256 });
    const compatibility = nativeCompatibility(protocol, machOs);
    const entitlements = { jit: join(evidence, 'native-inputs/jit-entitlements.plist'), virtualization: join(evidence, 'native-inputs/entitlements.plist') };
    const signatures = [];
    for (const policy of nativeExecutablePolicy) {
      const filename = join(bundle, policy.path);
      const prior = await run('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', filename]).then(result => ({ status: 0, ...result }), error => ({ status: error.code, stdout: error.stdout, stderr: error.stderr }));
      const args = signingArguments(identity, policy, filename, entitlements);
      await run('/usr/bin/codesign', args);
      await run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '--test-requirement', `=${requirement(policy.identifier)}`, filename]);
      const signed = await checkedFile(filename, { capture: true });
      const { path: _path, ...deployment } = machOs.find(value => value.path === policy.path);
      if (!isDeepStrictEqual(inspectMachO(signed.data, policy), deployment)) throw new Error('Signing changed executable deployment requirements.');
      const signedMetadata = await run('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', filename]);
      staged.set(policy.path, { bytes: signed.bytes, sha256: signed.sha256 });
      signatures.push({ path: policy.path, identifier: policy.identifier, prior, arguments: args, signedMetadata, signed: { bytes: signed.bytes, sha256: signed.sha256 } });
    }
    const mappings = signatures.map(value => ({ path: value.path, unsigned: unsigned.find(file => file.path === value.path), signed: value.signed,
      identifier: value.identifier, entitlements: nativeExecutablePolicy.find(policy => policy.path === value.path).entitlements === 'jit' ? jitEntitlements
        : value.path === helperPath ? ['com.apple.security.virtualization'] : [] }));
    const blockers = [...new Set([...guest.build.outstandingDistributionInputs.filter(value => value !== 'signed runtime assembly and installed acceptance'),
      'Complete host and guest Codex linked dependency sources and companion notices', 'Installed runtime and application acceptance', 'Notarization and Gatekeeper distribution assessment'])];
    await resource('Contents/Info.plist', infoPlist('1'));
    for (const notice of notices) await resource(`Contents/Resources/notices/codex-${notice.name}`, notice.data);
    await resource('Contents/Resources/notices/rat-things-LICENSE', firstParty.data);
    await resource('Contents/Resources/notices/NOTICE.txt', `Rat Things native runtime candidate\n\nThis bundle contains modified OpenAI Codex ${host.manifest.source.upstreamVersion}.\nThe source revision and ordered patches are recorded in provenance.json.\nOpenAI Codex LICENSE and NOTICE are included beside this file.\nThe guest retains its packaged license files inside the initramfs.\n\nThis signed candidate is not cleared for public distribution.\nOutstanding distribution inputs:\n${blockers.map(value => `- ${value}`).join('\n')}\n`);
    await resource('Contents/Resources/provenance.json', jsonBytes({ schemaVersion: 1, distributionReady: false, reproducibility: 'not-established',
      source: host.manifest.source, build: { host: host.manifest.build, guest: guest.artifact.build },
      unsignedInputs: { hostArtifactSha256: originalHost.sha256, guestArtifactSha256: guest.inputs.codexArtifactSha256, guestLockSha256: guest.build.lockSha256,
        guestInputsSha256: guest.build.inputsSha256, nativeSourceSha256: helperSource.sha256, nativeEntitlementsSha256: helperEntitlements.sha256, protocolSha256: protocolInput.sha256 },
      definitionInputs: ordered(sources.filter(value => value.path.startsWith('definition/'))), assemblerSources: ordered(sources.filter(value => builderSources.includes(value.path))),
      helperBuild: { swift: toolchain.swift, sdkVersion: toolchain.sdkVersion, sdkBuild: toolchain.sdkBuild, deploymentTarget },
      executables: mappings, deployment: machOs, outstandingDistributionInputs: blockers }));
    await resource('Contents/Resources/component-inventory.json', jsonBytes({ schemaVersion: 1, distributionReady: false,
      codex: { source: host.manifest.source, patchedTree: host.manifest.build.patchedTree, license: 'Apache-2.0', notice: 'notices/codex-NOTICE',
        host: { package: host.manifest.upstreamPackage, files: mappings.filter(value => value.path !== helperPath) },
        guest: { package: guest.artifact.upstreamPackage, archive: 'linux/worker-initramfs.gz', files: guest.artifact.files.map(file => ({ ...file, path: `opt/codex-runtime/${file.path}` })) },
        companions: Object.values(companions).map(value => ({ name: value.name, version: value.version, origin: value.resolved, integrity: value.integrity,
          license: 'NOASSERTION', noticeStatus: 'incomplete', files: value.files.filter(file => file.path !== 'bin/codex') })) },
      kernel: { ...kernel, archive: 'linux/worker-initramfs.gz', modules: guest.archive.entries.filter(entry => entry.path.startsWith(`lib/modules/${kernel.release}/`) && entry.sha256) },
      guestPackages: { origin: guest.inputs.base, packages: guest.inputs.transactions.native.packages, correspondingSources: 'not-retained',
        licenseFiles: guest.archive.entries.filter(entry => /^(usr\/share\/(licenses|doc)|opt\/rat-things\/licenses)\//.test(entry.path) && entry.sha256) },
      worker: { ...guest.worker, dependencies: guest.dependencies, sourceInputs: guest.inputs.sources,
        notices: { index: 'opt/rat-things/notices/javascript/index.json', sha256: guest.inputs.javascriptNoticesSha256 } },
      nativeHelper: { source: 'runtime/native/main.swift', sha256: helperSource.sha256, license: 'MIT', notice: 'notices/rat-things-LICENSE' }, outstandingDistributionInputs: blockers }));
    const beforeManifest = await nativeBundleInventory(bundle);
    if (staged.size !== expectedPaths.length || beforeManifest.some(file =>
      !isDeepStrictEqual(staged.get(file.path), { bytes: file.bytes, sha256: file.sha256 }))) {
      throw new Error('Staged runtime payload changed before manifest creation.');
    }
    const manifest = nativeManifest(`${host.manifest.source.upstreamVersion}-native-${host.manifest.build.patchedTree.slice(0, 12)}`, compatibility, beforeManifest, expectedPaths);
    await write(join(bundle, manifestPath), manifest.bytes);
    for (const [filename, expected] of tracked) await checkedFile(filename, { expected });
    await validateCodexRuntimeArtifact(hostArtifact, admissionOptions);
    await write(join(evidence, 'input-inventory.json'), jsonBytes(ordered(sources)));
    await write(join(evidence, 'signing.json'), jsonBytes({ identity, team: 'PB8NAVKU57', toolchain, compileArguments, signatures }));
    await chmod(join(bundle, 'Contents/Info.plist'), 0o644);
    await run('/usr/bin/codesign', signingArguments(identity, { identifier: 'dev.rat-things.runtime' }, bundle, entitlements));
    await chmod(join(bundle, 'Contents/Info.plist'), 0o444);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '--test-requirement', `=${requirement('dev.rat-things.runtime')}`, bundle]);
    const finalInventory = await nativeBundleInventory(bundle);
    if (!samePaths(finalInventory.map(file => file.path), [...expectedPaths, manifestPath, ...signaturePaths])
      || !isDeepStrictEqual(finalInventory.filter(file => expectedPaths.includes(file.path)), beforeManifest)
      || (await checkedFile(join(bundle, manifestPath))).sha256 !== manifest.releaseId) throw new Error('Outer signing changed the payload or generated unexpected signature files.');
    const signedTreeSha256 = nativeBundleFingerprint(finalInventory);
    await write(join(evidence, 'signed-inventory.json'), jsonBytes(finalInventory));
    const result = { schemaVersion: 1, status: 'signed-candidate', distributionReady: false, releaseId: manifest.releaseId, signedTreeSha256,
      bundle: 'Runtime.bundle', manifest: manifestPath, compatibility, outstandingDistributionInputs: blockers };
    await write(join(output, 'release.json'), jsonBytes(result));
    return result;
  } catch (error) {
    await write(join(output, 'failed-assembly.json'), jsonBytes({ status: 'failed', message: error.message }));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseNativeReleaseOptions(process.argv.slice(2));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native release signing requires Apple silicon macOS with Xcode.');
  const result = await assembleNativeRelease(options);
  console.log(JSON.stringify({ output: options.output, ...result }, null, 2));
}
