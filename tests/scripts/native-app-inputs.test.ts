import { createHash } from 'node:crypto';
import { appendFile, chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { assembleNativeApp } from '../../scripts/build-native-app.mjs';
import { nativeBundleFingerprint, nativeBundleInventory, nativeExecutablePolicy } from '../../scripts/build-native-release.mjs';
import { appExecutablePolicy, appInfoPlist, entitlementPlist, maximumMacOS, parseNativeAppOptions, requireAppSignature, requireNodeDefinition } from '../../scripts/native-app-inputs.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const identity = 'Developer ID Application: Fixture (PB8NAVKU57)';
const manifestPath = 'Contents/Resources/runtime-manifest.json';
const signatureNames = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'];
const protocol = { hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', appProtocol: 1, controllerProtocol: 1,
  workerProtocol: 1, workspaceFormat: 1, accountStateFormat: 1, profileSchema: 1 };

function macho(minimum = 15) {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x100000c, 4); bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20); bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE(minimum * 65536, 44);
  return bytes;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-native-app-fixture-')); directories.push(directory);
  const repositoryRoot = join(directory, 'repository'); const runtimeBundle = join(directory, 'Runtime.bundle');
  const nodeInputDirectory = join(directory, 'node-input'); const output = join(directory, 'output');
  const write = async (path: string, bytes: string | Uint8Array, mode = 0o444) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode });
  };
  for (const path of ['scripts/build-native-app.mjs', 'scripts/native-app-inputs.mjs', 'scripts/build-native-release.mjs', 'scripts/codex-runtime-artifact.mjs', 'scripts/codex-runtime-targets.mjs', 'scripts/native-guest-inputs.mjs', 'scripts/javascript-notices.mjs', 'scripts/native-build-files.mjs', 'scripts/native-guest-archive.mjs', 'src/domain/native-release.ts']) {
    await write(join(repositoryRoot, path), await readFile(resolve(path)));
  }
  await write(join(repositoryRoot, 'package.json'), json({ version: '0.1.0' }));
  await write(join(repositoryRoot, 'package-lock.json'), json({ packages: { 'node_modules/esbuild': { version: '0.25.3' } } }));
  await write(join(repositoryRoot, 'runtime/notices/javascript-supplements.json'), json({ schemaVersion: 1, packages: [], evidence: [] }));
  for (const path of ['src/cli.ts', 'scripts/console-server.ts']) await write(join(repositoryRoot, path), 'export const installed = __RAT_THINGS_INSTALLED__;');
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await write(join(repositoryRoot, name), name);
  for (const path of ['runtime/local/verify-runtime.swift', 'runtime/native/main.swift', 'desktop/Cargo.toml', 'desktop/Cargo.lock', 'desktop/src/main.rs', 'desktop/src/cli.rs', 'desktop/assets/font.ttf', 'desktop/assets/fonts/OFL.txt', 'assets/brand/rat-things.icns']) {
    await write(join(repositoryRoot, path), `fixture ${path}`);
  }
  await write(join(repositoryRoot, 'runtime/native/protocol.json'), json(protocol));
  const node = macho(11); const license = Buffer.from('Node fixture license'); const archive = Buffer.from('locked Node archive fixture');
  const archiveName = 'node-v22.23.4-darwin-arm64.tar.gz';
  const checksums = `${digest(archive)}  ${archiveName}\n`;
  const nodeDefinition = { version: '22.23.4', target: 'aarch64-apple-darwin', url: `https://nodejs.org/dist/v22.23.4/${archiveName}`,
    archiveSha256: digest(archive), checksumsURL: 'https://nodejs.org/dist/v22.23.4/SHASUMS256.txt', checksumsSha256: digest(checksums),
    files: { 'bin/node': { sha256: digest(node), bytes: node.length }, LICENSE: { sha256: digest(license), bytes: license.length } } };
  await write(join(repositoryRoot, 'runtime/native/node-input.json'), json(nodeDefinition));
  for (const [name, bytes] of [['node', node], ['LICENSE', license], [archiveName, archive], ['input.json', json(nodeDefinition)], ['SHASUMS256.txt', checksums]] as const) {
    await write(join(nodeInputDirectory, name), bytes, name === 'node' ? 0o755 : 0o444);
  }
  for (const policy of nativeExecutablePolicy) await write(join(runtimeBundle, policy.path), macho(), 0o755);
  await write(join(runtimeBundle, 'Contents/Info.plist'), 'fixture signed bundle plist');
  await write(join(runtimeBundle, 'Contents/Resources/provenance.json'), json({ schemaVersion: 1, distributionReady: false, outstandingDistributionInputs: ['Corresponding source archives'] }));
  await write(join(runtimeBundle, 'Contents/Resources/notices/NOTICE'), 'unchanged signed runtime notice');
  const files = await nativeBundleInventory(runtimeBundle);
  const compatibility = { hostTarget: protocol.hostTarget, guestTarget: protocol.guestTarget, minimumMacOS: '15.0.0',
    appProtocol: { minimum: 1, maximum: 1 }, controllerProtocol: { minimum: 1, maximum: 1 }, workerProtocol: 1,
    workspaceFormat: { read: [1], write: 1 }, accountStateFormat: 1, profileSchema: 1 };
  await write(join(runtimeBundle, manifestPath), json({ schemaVersion: 1, version: 'fixture-runtime', compatibility, files }));
  for (const name of signatureNames) await write(join(runtimeBundle, 'Contents/_CodeSignature', name), `fixture ${name}`);
  const calls: { command: string; arguments: string[]; environment?: NodeJS.ProcessEnv }[] = [];
  const signatures = new Map<string, { identifier: string; entitlements: string }>();
  const controls = { rejectRuntime: false, wrongTeam: false, mutateRuntimeDuringAppSign: false, unexpectedAppFile: false,
    unexpectedSignatureFile: false, mutateAppDuringOuterSign: false, rejectPackagedLaunch: false };
  const run = async (command: string, args: string[], settings: { env?: NodeJS.ProcessEnv } = {}) => {
    calls.push({ command, arguments: [...args], ...(settings.env ? { environment: settings.env } : {}) });
    const result = (stdout = '', stderr = '') => ({ stdout, stderr });
    if (command === '/usr/bin/xcrun') {
      if (args.includes('--show-sdk-path')) return result('/fixture/sdk\n');
      if (args.includes('--show-sdk-version')) return result('26.0\n');
      if (args.includes('--show-sdk-build-version')) return result('fixture-sdk\n');
      if (args.includes('--version')) return result('fixture Swift\n');
      if (args[0] === 'swiftc') {
        const path = args[args.indexOf('-o') + 1]!;
        await write(path, macho(args.includes('arm64-apple-macos11.0') ? 11 : 15), 0o755);
        return result();
      }
    }
    if (command === 'rustc') return result('rustc fixture\nhost: aarch64-apple-darwin\n');
    if (command === 'cargo') {
      if (args.includes('--version')) return result('cargo fixture\n');
      const target = args[args.indexOf('--target-dir') + 1]!;
      for (const name of ['rat-things-desktop', 'rat-things']) await write(join(target, 'aarch64-apple-darwin/release', name), macho(), 0o755);
      return result();
    }
    if (args[0] === 'verify-runtime') {
      return result(json(controls.rejectRuntime ? { schemaVersion: 1, kind: 'rejected' } : { schemaVersion: 1, kind: 'authenticated',
        manifestBase64: (await readFile(join(args[1]!, manifestPath))).toString('base64'), executablePaths: nativeExecutablePolicy.map(policy => policy.path) }));
    }
    if (command === '/usr/bin/codesign') {
      const path = args.at(-1)!;
      if (args.includes('--sign')) {
        signatures.set(path, { identifier: args[args.indexOf('--identifier') + 1]!, entitlements: args[args.indexOf('--entitlements') + 1]! });
        if ((await lstat(path)).isDirectory()) {
          await appendFile(join(path, 'Contents/MacOS/rat-things-desktop'), 'outer signature');
          await write(join(path, 'Contents/_CodeSignature/CodeResources'), 'sealed app resources');
          if (controls.mutateAppDuringOuterSign) await appendFile(join(path, 'Contents/Resources/cli.mjs'), '\nexport const unexpected = true;');
          if (controls.mutateRuntimeDuringAppSign) {
            const target = join(path, 'Contents/Resources/Runtime.bundle/Contents/Resources/notices/NOTICE');
            await chmod(target, 0o644); await appendFile(target, 'changed');
          }
        } else {
          await appendFile(path, 'fixture signature');
          if (path.endsWith('/Contents/MacOS/rat-things-desktop')) {
            const app = resolve(path, '../../..');
            await write(join(app, 'Contents/_CodeSignature/CodeResources'), 'implicit app resource seal', 0o644);
            if (controls.unexpectedAppFile) await write(join(app, 'Contents/Resources/unexpected.txt'), 'unexpected payload');
            if (controls.unexpectedSignatureFile) await write(join(app, 'Contents/_CodeSignature/unexpected'), 'unexpected seal');
          }
        }
        return result();
      }
      if (args.includes('--verify')) return result();
      const signed = signatures.get(path)!;
      return result(args.includes('--entitlements') ? await readFile(signed.entitlements, 'utf8') : '',
        `Identifier=${signed.identifier}\nTeamIdentifier=${controls.wrongTeam ? 'WRONGTEAM' : 'PB8NAVKU57'}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime)\nTimestamp=fixture secure timestamp\n`);
    }
    if (command === '/usr/bin/plutil') {
      const contents = await readFile(args.at(-1)!, 'utf8');
      return result(json(Object.fromEntries([...contents.matchAll(/<key>([^<]+)<\/key><true\/>/g)].map(match => [match[1], true]))));
    }
    if (command.endsWith('/Contents/MacOS/node')) return result(args[0] === '--check' ? '' : json({ version: '22.23.4', value: 42 }));
    if (command.endsWith('/Contents/MacOS/rat-things')) {
      if (controls.rejectPackagedLaunch) throw new Error('Packaged CLI launch failed');
      return result('Rat Things\n\n  rat-things runtime doctor|setup [--json]\n');
    }
    throw new Error(`Unexpected fixture command ${command}`);
  };
  return { directory, repositoryRoot, runtimeBundle, nodeInputDirectory, output, nodeDefinition, checksums, calls, controls, run,
    options: { runtimeBundle, nodeInputDirectory, output, identity }, write };
}

it('requires every explicit input and the fixed Developer ID team', () => {
  expect(() => parseNativeAppOptions([])).toThrow('Required options');
  const args = ['--runtime-bundle', '/runtime', '--node-input-directory', '/node', '--identity', identity, '--output', '/output'];
  expect(parseNativeAppOptions(args)).toMatchObject({ runtimeBundle: '/runtime', nodeInputDirectory: '/node', identity, output: '/output' });
  expect(() => parseNativeAppOptions([...args, '--output', '/elsewhere'])).toThrow('unique');
  expect(() => parseNativeAppOptions(args.map(value => value === identity ? '-' : value))).toThrow('Developer ID');
  expect(() => parseNativeAppOptions([...args, '--node', process.execPath])).toThrow('unique');
});

it('admits the recorded top-level Node input layout and publication checksums', async () => {
  const f = await fixture();
  expect(requireNodeDefinition(f.nodeDefinition, structuredClone(f.nodeDefinition), f.checksums).map(file => file.source))
    .toEqual(['node', 'LICENSE', 'node-v22.23.4-darwin-arm64.tar.gz', 'SHASUMS256.txt']);
  expect(() => requireNodeDefinition(f.nodeDefinition, { ...f.nodeDefinition, version: '22.0.0' }, f.checksums)).toThrow('maintained');
  expect(() => requireNodeDefinition(f.nodeDefinition, f.nodeDefinition, 'missing archive')).toThrow('locked archive');
});

it('uses the greatest measured deployment version and rejects invalid versions', () => {
  expect(maximumMacOS(['11.0.0', '15.0', '14.7.2', '15.0.1'])).toBe('15.0.1');
  expect(appInfoPlist('0.1.0', '15.0.1')).toContain('<key>LSMinimumSystemVersion</key><string>15.0.1</string>');
  expect(() => maximumMacOS([])).toThrow('measured');
  expect(() => appInfoPlist('0.1.0', 'unknown')).toThrow('measured');
});

it('rejects ad-hoc, wrong-team, missing timestamp, and excess entitlement evidence', () => {
  const policy = appExecutablePolicy[0]!;
  const metadata = `Identifier=${policy.identifier}\nTeamIdentifier=PB8NAVKU57\nCodeDirectory v=20500 flags=0x10000(runtime)\nTimestamp=fixture\n`;
  const entitlements = Object.fromEntries(policy.entitlements.map(key => [key, true]));
  expect(() => requireAppSignature(metadata, entitlements, policy)).not.toThrow();
  expect(() => requireAppSignature(metadata.replace('(runtime)', '(adhoc)'), entitlements, policy)).toThrow('signature');
  expect(() => requireAppSignature(metadata.replace('PB8NAVKU57', 'WRONGTEAM'), entitlements, policy)).toThrow('signature');
  expect(() => requireAppSignature(metadata.replace('Timestamp=fixture', ''), entitlements, policy)).toThrow('signature');
  expect(() => requireAppSignature(metadata, { ...entitlements, 'com.apple.security.get-task-allow': true }, policy)).toThrow('entitlement');
});

it('assembles both installed launchers and services while preserving the signed runtime', async () => {
  const f = await fixture();
  const before = nativeBundleFingerprint(await nativeBundleInventory(f.runtimeBundle));
  const result = await assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run });
  expect(result).toMatchObject({ status: 'signed-app-candidate', distributionReady: false, minimumMacOS: '15.0.0', runtime: { signedTreeSha256: before } });
  const app = await realpath(join(f.output, 'Rat Things.app'));
  expect(nativeBundleFingerprint(await nativeBundleInventory(join(app, 'Contents/Resources/Runtime.bundle')))).toBe(before);
  expect(nativeBundleFingerprint(await nativeBundleInventory(f.runtimeBundle))).toBe(before);
  for (const name of ['cli.mjs', 'console-server.mjs']) {
    expect((await import(pathToFileURL(join(app, 'Contents/Resources', name)).href)).installed).toBe(true);
  }
  const cargo = f.calls.find(call => call.command === 'cargo' && call.arguments[0] === 'build')!;
  expect(cargo.arguments).toEqual(expect.arrayContaining(['--locked', '--release', '--features', 'installed-runtime', '--bin', 'rat-things-desktop', 'rat-things']));
  expect(cargo.environment).toMatchObject({ CARGO_BUILD_JOBS: '1', MACOSX_DEPLOYMENT_TARGET: '15.0.0' });
  const signatures = f.calls.filter(call => call.command === '/usr/bin/codesign' && call.arguments.includes('--sign'));
  expect(signatures.map(call => call.arguments.at(-1)!.slice(app.length + 1))).toEqual([
    'Contents/MacOS/node', 'Contents/Helpers/rat-runtime-verifier', 'Contents/Helpers/rat-native-recovery', 'Contents/MacOS/rat-things', 'Contents/MacOS/rat-things-desktop', '',
  ]);
  for (const signature of signatures) {
    expect(signature.arguments).toEqual(expect.arrayContaining(['--options', 'runtime', '--timestamp']));
    expect(signature.arguments).not.toContain('--deep');
    expect(signature.arguments.at(-1)).not.toContain('Runtime.bundle');
  }
  const node = JSON.parse(await readFile(join(f.output, 'evidence/signing.json'), 'utf8')).signatures[0];
  expect(node.entitlements).toEqual({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.allow-unsigned-executable-memory': true });
  expect(await readFile(join(app, 'Contents/Resources/notices/node-LICENSE'), 'utf8')).toBe('Node fixture license');
  expect(await readFile(join(app, 'Contents/Resources/notices/Inter-OFL.txt'), 'utf8')).toBe('fixture desktop/assets/fonts/OFL.txt');
  expect(await readFile(join(app, 'Contents/Resources/AppIcon.icns'), 'utf8')).toBe('fixture assets/brand/rat-things.icns');
  expect(await readFile(join(app, 'Contents/Info.plist'), 'utf8')).toContain('<key>CFBundleIconFile</key><string>AppIcon</string>');
  expect(await readFile(join(f.nodeInputDirectory, 'node'))).toEqual(macho(11));
  expect(JSON.parse(await readFile(join(app, 'Contents/Resources/app-provenance.json'), 'utf8')).executableSigningStage).toBe('before-application-seal');
});

it('rejects a Node checksum mismatch before invoking a compiler or signer', async () => {
  const f = await fixture();
  await appendFile(join(f.nodeInputDirectory, 'node'), 'wrong input');
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('checksum');
  expect(f.calls).toEqual([]);
  await expect(lstat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects an unexpected payload alongside the main executable signature seal', async () => {
  const f = await fixture(); f.controls.unexpectedAppFile = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('exact assembly inventory');
  expect(f.calls.some(call => call.command === '/usr/bin/codesign' && call.arguments.includes('--sign')
    && call.arguments.at(-1) === join(f.output, 'Rat Things.app'))).toBe(false);
});

it('rejects an unknown file in the signature directory', async () => {
  const f = await fixture(); f.controls.unexpectedSignatureFile = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('exact assembly inventory');
});

it('rejects a bundled service changed during outer signing', async () => {
  const f = await fixture(); f.controls.mutateAppDuringOuterSign = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('changed its nested executables or resources');
});

it('rejects a signed app whose packaged CLI cannot launch', async () => {
  const f = await fixture(); f.controls.rejectPackagedLaunch = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('Packaged CLI launch failed');
  await expect(lstat(join(f.output, 'app-build.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bundles the actual installed services and records their locked dependencies without starting them', async () => {
  const f = await fixture();
  await rm(join(f.repositoryRoot, 'src'), { recursive: true, force: true });
  await cp(resolve('src'), join(f.repositoryRoot, 'src'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'scripts/console-server.ts']) {
    await rm(join(f.repositoryRoot, name)); await cp(resolve(name), join(f.repositoryRoot, name));
  }
  for (const name of ['spec/schemas/agents-api.schema.json', 'runtime/local/images.json', 'runtime/codex/model-capabilities.json', 'runtime/codex/model-defaults.json']) {
    await f.write(join(f.repositoryRoot, name), await readFile(resolve(name)));
  }
  const discovery = await build({ entryPoints: ['src/cli.ts', 'scripts/console-server.ts'], outdir: 'unused', write: false,
    bundle: true, platform: 'node', format: 'esm', metafile: true, define: { __RAT_THINGS_INSTALLED__: 'true' } });
  const owners = new Set(Object.keys(discovery.metafile.inputs).filter(path => path.startsWith('node_modules/')).map(path => {
    const parts = path.split('/'); const first = parts.lastIndexOf('node_modules') + 1;
    return parts.slice(0, first + (parts[first]!.startsWith('@') ? 2 : 1)).join('/');
  }));
  for (const path of owners) await cp(resolve(path), join(f.repositoryRoot, path), { recursive: true,
    filter: source => !relative(resolve(path), source).split('/').includes('node_modules') });
  await rm(join(f.repositoryRoot, 'runtime/notices'), { recursive: true });
  await cp(resolve('runtime/notices'), join(f.repositoryRoot, 'runtime/notices'), { recursive: true });
  await assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run });
  const resources = join(f.output, 'Rat Things.app/Contents/Resources');
  const dependencies = JSON.parse(await readFile(join(resources, 'app-dependencies.json'), 'utf8'));
  expect(dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'openai', version: '7.23.0' })]));
  const notices = JSON.parse(await readFile(join(resources, 'notices/javascript/index.json'), 'utf8'));
  expect(notices.packages).toHaveLength(dependencies.length);
  const openai = notices.packages.find((value: { name: string }) => value.name === 'openai');
  expect(openai.files).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePath: 'src/_vendor/partial-json-parser/LICENSE' })]));
  for (const owner of notices.packages) for (const file of owner.files) {
    const bytes = await readFile(join(resources, 'notices/javascript', file.path));
    expect(digest(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.bytes);
  }
  for (const name of ['cli.mjs', 'console-server.mjs']) {
    const contents = await readFile(join(resources, name), 'utf8');
    expect(contents).not.toContain('__RAT_THINGS_INSTALLED__');
    expect(contents.length).toBeGreaterThan(100_000);
  }
  expect(f.calls.filter(call => call.command.endsWith('/Contents/MacOS/node')).map(call => call.arguments[0])).toEqual(['--check', '--check', '--input-type=module']);
}, 20_000);

async function fixtureDependency(f: Awaited<ReturnType<typeof fixture>>, license?: string) {
  const directory = join(f.repositoryRoot, 'node_modules/example');
  await f.write(join(directory, 'package.json'), json({ name: 'example', version: '1.0.0', main: 'index.js', license: 'MIT' }));
  await f.write(join(directory, 'index.js'), 'export const value = 42;');
  if (license !== undefined) await f.write(join(directory, 'LICENSE'), license);
  await chmod(join(f.repositoryRoot, 'src/cli.ts'), 0o644);
  await writeFile(join(f.repositoryRoot, 'src/cli.ts'), "export { value } from 'example';");
  const lockPath = join(f.repositoryRoot, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['node_modules/example'] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-fixture' };
  await chmod(lockPath, 0o644); await writeFile(lockPath, json(lock));
  return directory;
}

it('rejects a missing dependency license payload before invoking any signer', async () => {
  const f = await fixture(); await fixtureDependency(f);
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('Missing license payload');
  expect(f.calls.some(call => call.command === '/usr/bin/codesign' && call.arguments.includes('--sign'))).toBe(false);
});

it.each(['added', 'changed'] as const)('rejects %s legal inputs before sealing the application', async kind => {
  const f = await fixture(); const directory = await fixtureDependency(f, 'Original license'); let changed = false;
  const run: typeof f.run = async (command, args, settings) => {
    const result = await f.run(command, args, settings);
    if (!changed && command === '/usr/bin/codesign' && args.includes('--sign')) {
      changed = true;
      if (kind === 'changed') await chmod(join(directory, 'LICENSE'), 0o644);
      await writeFile(join(directory, kind === 'added' ? 'NOTICE' : 'LICENSE'), 'Changed during assembly');
    }
    return result;
  };
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run })).rejects.toThrow(/changed|checksum differs/);
  expect(f.calls.some(call => call.command === '/usr/bin/codesign' && call.arguments.includes('--sign') && call.arguments.at(-1)!.endsWith('.app'))).toBe(false);
  await expect(lstat(join(f.output, 'app-build.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects staged notice mutation during nested signing before sealing the application', async () => {
  const f = await fixture(); await fixtureDependency(f, 'Original license'); let changed = false;
  const run: typeof f.run = async (command, args, settings) => {
    const result = await f.run(command, args, settings);
    if (!changed && command === '/usr/bin/codesign' && args.includes('--sign')) {
      changed = true;
      const notice = join(f.output, 'Rat Things.app/Contents/Resources/notices/javascript/files/0000/0000.txt');
      await chmod(notice, 0o644); await writeFile(notice, 'Changed staged notice'); await chmod(notice, 0o444);
    }
    return result;
  };
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run })).rejects.toThrow('Staged app payload changed');
  expect(f.calls.some(call => call.command === '/usr/bin/codesign' && call.arguments.includes('--sign') && call.arguments.at(-1)!.endsWith('.app'))).toBe(false);
});

it('rejects linked Node inputs and existing or dist-contained outputs', async () => {
  const f = await fixture();
  const node = join(f.nodeInputDirectory, 'node');
  await cp(node, join(f.directory, 'elsewhere')); await rm(node); await symlink(join(f.directory, 'elsewhere'), node);
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow();
  expect(f.calls).toEqual([]);
  await mkdir(f.output);
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('new directory');
  await mkdir(join(f.repositoryRoot, 'dist'));
  await expect(assembleNativeApp({ ...f.options, output: join(f.repositoryRoot, 'dist/app') }, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('outside dist');
});

it('does not create output parents inside the signed runtime or Node inputs', async () => {
  const f = await fixture();
  for (const input of [f.runtimeBundle, f.nodeInputDirectory]) {
    const output = join(input, 'new-parent', 'output');
    await expect(assembleNativeApp({ ...f.options, output }, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow();
    await expect(lstat(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(f.calls).toEqual([]);
});

it('rejects unauthenticated runtime input before Cargo or signing and records failure', async () => {
  const f = await fixture(); f.controls.rejectRuntime = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('authenticate');
  expect(f.calls.some(call => call.command === 'cargo' && call.arguments[0] === 'build')).toBe(false);
  expect(f.calls.some(call => call.command === '/usr/bin/codesign')).toBe(false);
  expect(JSON.parse(await readFile(join(f.output, 'failed-app-build.json'), 'utf8')).status).toBe('failed');
  await expect(lstat(join(f.output, 'app-build.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a signer with the wrong team and leaves no success record', async () => {
  const f = await fixture(); f.controls.wrongTeam = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('signature');
  await expect(lstat(join(f.output, 'app-build.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('detects runtime mutation during outer app signing', async () => {
  const f = await fixture(); f.controls.mutateRuntimeDuringAppSign = true;
  await expect(assembleNativeApp(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('changed the signed runtime');
  await expect(lstat(join(f.output, 'app-build.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('assigns only virtualization to recovery and no entitlements to the other app-owned helpers', () => {
  expect(appExecutablePolicy.find(policy => policy.path.endsWith('rat-native-recovery'))!.entitlements).toEqual(['com.apple.security.virtualization']);
  for (const name of ['rat-runtime-verifier', 'rat-things', 'rat-things-desktop']) {
    expect(appExecutablePolicy.find(policy => policy.path.endsWith(`/${name}`))!.entitlements).toEqual([]);
  }
  expect(entitlementPlist([])).not.toContain('<key>');
});
