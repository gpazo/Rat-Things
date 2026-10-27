import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { build, version as esbuildVersion } from 'esbuild';
import { checkedFile, inspectMachO, nativeBundleFingerprint, nativeBundleInventory, nativeExecutablePolicy } from './build-native-release.mjs';
import { APP_IDENTIFIER, RUNTIME_PATH, appExecutablePolicy, appInfoPlist, appSigningArguments, developerIdRequirement,
  entitlementPlist, maximumMacOS, parseNativeAppOptions, requireAppSignature, requireNodeDefinition } from './native-app-inputs.mjs';
import { collectJavaScriptNotices } from './javascript-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ordered = values => [...values].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const signaturePaths = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'].map(path => `Contents/_CodeSignature/${path}`);
const runtimeManifestPath = 'Contents/Resources/runtime-manifest.json';
const verifierLimits = ['4096', String(768 * 1024 ** 2), String(2 * 1024 ** 3), String(128 * 1024), '32', '1024'];
const inside = (directory, path) => path === directory || path.startsWith(directory + '/');

async function regularDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a regular input directory: ${path}.`);
  return realpath(path);
}

async function appInventory(bundle) {
  const result = []; const names = new Set(); let entries = 0; let total = 0;
  const executables = new Set(appExecutablePolicy.map(policy => policy.path));
  async function visit(directory, prefix = '') {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (++entries > 4096 || path.split('/').length > 32 || Buffer.byteLength(path) > 1024
        || /[\\:\u0000-\u001f\u007f]/.test(path) || path.normalize('NFC') !== path || names.has(path.toLowerCase())) throw new Error('Invalid or unbounded app inventory.');
      names.add(path.toLowerCase());
      if (path === RUNTIME_PATH) { await regularDirectory(join(bundle, path)); continue; }
      if (child.isDirectory()) await visit(join(directory, child.name), path);
      else if (child.isFile()) {
        const filename = join(bundle, path); const info = await lstat(filename);
        const file = await checkedFile(filename, { maximumBytes: 192 * 1024 ** 2 });
        total += file.bytes;
        if (total > 512 * 1024 ** 2 || (info.mode & 0o7022) || Boolean(info.mode & 0o111) !== executables.has(path)) throw new Error('Unexpected app file permissions or size.');
        result.push({ path, ...file, executable: executables.has(path) });
      } else throw new Error('The app contains a symlink or special file.');
    }
  }
  await visit(bundle);
  return ordered(result);
}

export async function assembleNativeApp(options, { repositoryRoot = root,
  run = async (command, args, settings = {}) => execute(command, args, { timeout: 120_000, maxBuffer: 8 * 1024 ** 2, ...settings }) } = {}) {
  const repository = await realpath(repositoryRoot);
  const runtimeBundle = await regularDirectory(options.runtimeBundle);
  const nodeDirectory = await regularDirectory(options.nodeInputDirectory);
  const requestedOutput = resolve(options.output);
  if (inside(join(repository, 'dist'), requestedOutput)) throw new Error('Native app output must be outside dist and its input directories.');
  const parent = await regularDirectory(dirname(requestedOutput));
  const output = join(parent, basename(requestedOutput));
  if (inside(join(repository, 'dist'), parent) || output === join(repository, 'dist')
    || [runtimeBundle, nodeDirectory].some(path => inside(path, parent))) throw new Error('Native app output must be outside dist and its input directories.');
  try { await lstat(output); throw new Error('Native app output must be a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tracked = new Map(); const sources = new Map();
  const input = async (filename, label, settings = {}) => {
    const admitted = await checkedFile(filename, { maximumBytes: 32 * 1024 ** 2, capture: true, ...settings });
    const expected = { bytes: admitted.bytes, sha256: admitted.sha256 };
    if (tracked.has(filename) && !isDeepStrictEqual(tracked.get(filename), expected)) throw new Error(`App input changed: ${label}.`);
    tracked.set(filename, expected);
    sources.set(label, { path: label, ...expected });
    return admitted;
  };
  const nodeDefinitionBytes = (await input(join(repository, 'runtime/native/node-input.json'), 'runtime/native/node-input.json')).data;
  const nodeDefinition = JSON.parse(nodeDefinitionBytes);
  const recordedNode = (await input(join(nodeDirectory, 'input.json'), 'node/input.json')).data;
  const checksums = (await input(join(nodeDirectory, 'SHASUMS256.txt'), 'node/SHASUMS256.txt', { maximumBytes: 1024 * 1024 })).data;
  const nodeInputs = requireNodeDefinition(nodeDefinition, JSON.parse(recordedNode), checksums.toString('utf8'));
  for (const file of nodeInputs) await input(join(nodeDirectory, file.source), `node/${file.source}`, { expected: file.expected, maximumBytes: file.maximumBytes, capture: false });
  const originalRuntime = await nativeBundleInventory(runtimeBundle);
  const runtimeFingerprint = nativeBundleFingerprint(originalRuntime);
  const initialManifest = await checkedFile(join(runtimeBundle, runtimeManifestPath), { capture: true, maximumBytes: 128 * 1024 });
  const packageInput = JSON.parse((await input(join(repository, 'package.json'), 'package.json')).data);
  const npmLock = JSON.parse((await input(join(repository, 'package-lock.json'), 'package-lock.json')).data);
  if (npmLock.packages?.['node_modules/esbuild']?.version !== esbuildVersion) throw new Error('Installed app bundling requires the locked esbuild version.');
  const protocol = JSON.parse((await input(join(repository, 'runtime/native/protocol.json'), 'runtime/native/protocol.json')).data);
  for (const name of ['runtime/native/host-code-policy.json', 'scripts/build-native-app.mjs', 'scripts/native-app-inputs.mjs', 'scripts/build-native-release.mjs', 'scripts/codex-runtime-artifact.mjs', 'scripts/codex-runtime-targets.mjs', 'scripts/native-guest-inputs.mjs', 'scripts/javascript-notices.mjs', 'scripts/native-build-files.mjs', 'scripts/native-guest-archive.mjs']) {
    await input(join(repository, name), name);
  }
  await mkdir(output, { mode: 0o700 });
  const context = await mkdtemp(join(tmpdir(), 'rat-native-app-build-'));
  const app = join(output, 'Rat Things.app'); const evidence = join(output, 'evidence');
  const processEvidence = []; const expectedPaths = new Set(); const staged = new Map();
  const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'DEVELOPER_DIR']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const command = async (binary, args, settings = {}) => {
    try {
      const result = await run(binary, args, { cwd: repository, env: environment, ...settings });
      processEvidence.push({ command: binary, arguments: args, stdout: result.stdout, stderr: result.stderr, status: 0 });
      return result;
    } catch (error) {
      processEvidence.push({ command: binary, arguments: args, stdout: error.stdout ?? '', stderr: error.stderr ?? '', status: error.code ?? 'failed' });
      throw error;
    }
  };
  const write = async (filename, bytes) => { await mkdir(dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o444 }); };
  const resource = async (path, bytes) => {
    await write(join(app, path), bytes); expectedPaths.add(path);
    staged.set(path, { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
  };
  try {
    await mkdir(evidence); await mkdir(join(app, 'Contents/MacOS'), { recursive: true }); await mkdir(join(app, 'Contents/Helpers'));
    const verifierSource = await input(join(repository, 'runtime/local/verify-runtime.swift'), 'runtime/local/verify-runtime.swift');
    const recoverySource = await input(join(repository, 'runtime/native/main.swift'), 'runtime/native/main.swift');
    await write(join(context, 'verify-runtime.swift'), verifierSource.data);
    await write(join(context, 'main.swift'), recoverySource.data);
    const sdk = (await command('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'])).stdout.trim();
    if (!sdk.startsWith('/') || /[\r\n\0]/.test(sdk)) throw new Error('Could not locate the macOS SDK.');
    const toolchain = {
      swift: (await command('/usr/bin/xcrun', ['swiftc', '--version'])).stdout.trim(),
      sdkVersion: (await command('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'])).stdout.trim(),
      sdkBuild: (await command('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version'])).stdout.trim(),
      cargo: (await command('cargo', ['--version'])).stdout.trim(), rust: (await command('rustc', ['-vV'])).stdout.trim(), esbuild: esbuildVersion,
    };
    const verifier = join(context, 'rat-runtime-verifier');
    await command('/usr/bin/xcrun', ['swiftc', join(context, 'verify-runtime.swift'), '-O', '-target', 'arm64-apple-macos11.0', '-sdk', sdk, '-framework', 'Security', '-o', verifier]);
    const verifyRuntime = async path => {
      const response = JSON.parse((await command(verifier, ['verify-runtime', path, ...verifierLimits], { cwd: '/', env: {}, timeout: 60_000, maxBuffer: 256 * 1024 })).stdout);
      if (response.schemaVersion !== 1 || response.kind !== 'authenticated' || typeof response.manifestBase64 !== 'string'
        || response.manifestBase64 !== initialManifest.data.toString('base64')
        || !isDeepStrictEqual([...response.executablePaths ?? []].sort(), nativeExecutablePolicy.map(policy => policy.path).sort())) throw new Error('The independent verifier did not authenticate the expected runtime.');
    };
    await verifyRuntime(runtimeBundle);
    await input(join(repository, 'src/domain/native-release.ts'), 'src/domain/native-release.ts');
    await build({ absWorkingDir: repository, stdin: { contents: "export {decodeAuthenticatedNativeManifest,nativeCompatibility} from './src/domain/native-release.ts';", resolveDir: repository },
      outfile: join(context, 'manifest-domain.mjs'), platform: 'node', format: 'esm', target: 'node22', bundle: true });
    const domain = await import(pathToFileURL(join(context, 'manifest-domain.mjs')).href);
    const manifest = domain.decodeAuthenticatedNativeManifest(JSON.parse(initialManifest.data));
    const failure = domain.nativeCompatibility(manifest, { ...protocol, macOS: manifest.compatibility.minimumMacOS });
    if (failure) throw new Error(`Runtime compatibility differs from the installed app: ${failure.fields.join(', ')}.`);
    const payload = originalRuntime.filter(file => file.path !== runtimeManifestPath && !signaturePaths.includes(file.path));
    if (!isDeepStrictEqual(ordered(manifest.files), payload)) throw new Error('Authenticated runtime manifest differs from its file inventory.');
    const runtimeDeployment = [];
    for (const policy of nativeExecutablePolicy) {
      const bytes = (await checkedFile(join(runtimeBundle, policy.path), { expected: originalRuntime.find(file => file.path === policy.path), capture: true })).data;
      const deployment = inspectMachO(bytes);
      if (maximumMacOS([deployment.minimumMacOS, manifest.compatibility.minimumMacOS]) !== manifest.compatibility.minimumMacOS) throw new Error('Runtime manifest understates a host executable macOS requirement.');
      runtimeDeployment.push({ path: policy.path, ...deployment });
    }
    const runtimeProvenance = JSON.parse((await checkedFile(join(runtimeBundle, 'Contents/Resources/provenance.json'), { capture: true, maximumBytes: 8 * 1024 ** 2 })).data);
    if (runtimeProvenance.distributionReady !== false || !Array.isArray(runtimeProvenance.outstandingDistributionInputs)
      || !runtimeProvenance.outstandingDistributionInputs.every(value => typeof value === 'string' && value.length <= 1024)) throw new Error('Runtime distribution provenance is incomplete.');
    for (const file of originalRuntime) {
      const filename = join(runtimeBundle, file.path); const info = await lstat(filename);
      await checkedFile(filename, { expected: file, destination: join(app, RUNTIME_PATH, file.path), mode: info.mode & 0o777 });
    }
    const copiedRuntime = join(app, RUNTIME_PATH);
    if (nativeBundleFingerprint(await nativeBundleInventory(copiedRuntime)) !== runtimeFingerprint) throw new Error('Runtime changed while copying into the app.');
    for (const file of nodeInputs.filter(file => file.target)) {
      const copied = await checkedFile(join(nodeDirectory, file.source), { expected: file.expected, maximumBytes: file.maximumBytes, destination: join(app, file.target), mode: file.mode });
      if (!appExecutablePolicy.some(policy => policy.path === file.target)) staged.set(file.target, { bytes: copied.bytes, sha256: copied.sha256 });
      expectedPaths.add(file.target);
    }
    const deployment = [{ path: 'Contents/MacOS/node', ...inspectMachO((await checkedFile(join(app, 'Contents/MacOS/node'), { capture: true })).data) }];
    const deploymentTarget = maximumMacOS([manifest.compatibility.minimumMacOS, deployment[0].minimumMacOS]);
    await checkedFile(verifier, { destination: join(app, 'Contents/Helpers/rat-runtime-verifier'), mode: 0o755 });
    expectedPaths.add('Contents/Helpers/rat-runtime-verifier');
    await command('/usr/bin/xcrun', ['swiftc', join(context, 'main.swift'), '-O', '-target', `arm64-apple-macos${deploymentTarget}`, '-sdk', sdk,
      '-framework', 'Virtualization', '-o', join(app, 'Contents/Helpers/rat-native-recovery')]);
    await chmod(join(app, 'Contents/Helpers/rat-native-recovery'), 0o755); expectedPaths.add('Contents/Helpers/rat-native-recovery');
    const copySources = async (directory, destination, label) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${label}/${entry.name}`;
        if (entry.isDirectory()) await copySources(join(directory, entry.name), join(destination, entry.name), name);
        else if (entry.isFile()) await write(join(destination, entry.name), (await input(join(directory, entry.name), name)).data);
        else throw new Error('Native app source inputs must be regular files.');
      }
    };
    for (const name of ['Cargo.toml', 'Cargo.lock']) await write(join(context, 'desktop', name), (await input(join(repository, 'desktop', name), `desktop/${name}`)).data);
    for (const name of ['src', 'assets']) await copySources(join(repository, 'desktop', name), join(context, 'desktop', name), `desktop/${name}`);
    const cargoArguments = ['build', '--locked', '--release', '--features', 'installed-runtime', '--manifest-path', join(context, 'desktop/Cargo.toml'),
      '--target', 'aarch64-apple-darwin', '--target-dir', join(context, 'cargo-target'), '--bin', 'rat-things-desktop', '--bin', 'rat-things'];
    await command('cargo', cargoArguments, { cwd: context, timeout: 60 * 60_000,
      env: { ...environment, MACOSX_DEPLOYMENT_TARGET: deploymentTarget, CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0' } });
    for (const name of ['rat-things-desktop', 'rat-things']) {
      const path = `Contents/MacOS/${name}`;
      await checkedFile(join(context, 'cargo-target/aarch64-apple-darwin/release', name), { destination: join(app, path), mode: 0o755 }); expectedPaths.add(path);
    }
    const dependencies = new Map(); const bundles = [];
    const captureSources = { name: 'installed-app-inputs', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?|json)$/ }, async ({ path }) => {
        const normalized = path.replaceAll('\\', '/'); const index = normalized.indexOf('/node_modules/');
        const label = index === -1 ? relative(repository, path) : normalized.slice(index + 1);
        if (label.startsWith('../')) throw new Error('App bundling reached a source outside the repository or dependency tree.');
        const bytes = (await input(path, label)).data;
        if (index !== -1) {
          const segments = label.split('/'); const first = segments.lastIndexOf('node_modules') + 1;
          const packagePath = segments.slice(0, first + (segments[first].startsWith('@') ? 2 : 1)).join('/');
          const installed = JSON.parse((await input(join(repository, packagePath, 'package.json'), `${packagePath}/package.json`)).data);
          const locked = npmLock.packages[packagePath];
          if (!locked || locked.version !== installed.version || (locked.name && locked.name !== installed.name)) throw new Error(`App dependency differs from package-lock.json: ${packagePath}.`);
          dependencies.set(packagePath, { path: packagePath, name: installed.name, version: installed.version, resolved: locked.resolved, integrity: locked.integrity, license: installed.license ?? null });
        }
        const extension = extname(path).slice(1);
        return { contents: bytes, loader: ['ts', 'tsx', 'jsx', 'json'].includes(extension) ? extension : 'js' };
      });
    } };
    const bundleOptions = { absWorkingDir: repository, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
      treeShaking: true, legalComments: 'external', define: { __RAT_THINGS_INSTALLED__: 'true' }, plugins: [captureSources],
      banner: { js: "import { createRequire as __ratRequire } from 'node:module'; const require = __ratRequire(import.meta.url);" } };
    for (const [entry, name] of [['src/cli.ts', 'cli.mjs'], ['scripts/console-server.ts', 'console-server.mjs']]) {
      const path = `Contents/Resources/${name}`;
      const result = await build({ ...bundleOptions, entryPoints: [entry], outfile: join(app, path) });
      await chmod(join(app, path), 0o644); expectedPaths.add(path);
      const legalPath = `${path}.LEGAL.txt`;
      try { staged.set(legalPath, await checkedFile(join(app, legalPath))); expectedPaths.add(legalPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const identity = await checkedFile(join(app, path)); staged.set(path, identity);
      bundles.push({ entry, path, ...identity, metafile: result.metafile });
    }
    const javascriptNotices = await collectJavaScriptNotices({ root: repository, dependencies: [...dependencies.values()], lock: npmLock, surface: 'app',
      readInput: async (filename, label, settings) => (await input(filename, label, settings)).data });
    for (const file of javascriptNotices.files) await resource(`Contents/Resources/notices/javascript/${file.path}`, file.bytes);
    for (const policy of appExecutablePolicy.filter(policy => policy.path !== 'Contents/MacOS/node')) {
      deployment.push({ path: policy.path, ...inspectMachO((await checkedFile(join(app, policy.path), { capture: true })).data) });
    }
    const minimumMacOS = maximumMacOS([manifest.compatibility.minimumMacOS, ...deployment.map(binary => binary.minimumMacOS)]);
    await resource('Contents/Info.plist', appInfoPlist(packageInput.version, minimumMacOS));
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await resource(`Contents/Resources/notices/${name}`, (await input(join(repository, name), name)).data);
    await resource('Contents/Resources/AppIcon.icns', (await input(join(repository, 'assets/brand/rat-things.icns'), 'assets/brand/rat-things.icns')).data);
    await resource('Contents/Resources/notices/Inter-OFL.txt', (await input(join(repository, 'desktop/assets/fonts/OFL.txt'), 'desktop/assets/fonts/OFL.txt')).data);
    await resource('Contents/Resources/node-input.json', nodeDefinitionBytes);
    await resource('Contents/Resources/app-dependencies.json', jsonBytes(ordered([...dependencies.values()])));
    const blockers = [...new Set([...runtimeProvenance.outstandingDistributionInputs, 'Complete application native dependency sources and notices',
      'Independent installed application acceptance', 'Notarization and Gatekeeper distribution assessment'])];
    await resource('Contents/Resources/notices/DISTRIBUTION.txt', `Rat Things installed application candidate\n\nThis signed app is not cleared for public distribution.\nNode.js ${nodeDefinition.version} license is included as node-LICENSE.\nThe signed runtime retains its original manifest, provenance and notices.\nBundled JavaScript legal notices are retained beside each service file when present.\nOutstanding distribution inputs:\n${blockers.map(value => `- ${value}`).join('\n')}\n`);
    const signatures = [];
    const inspectSignature = async (policy, path, name = policy.identifier.replaceAll('.', '-')) => {
      const display = await command('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', path]);
      let entitlements = {};
      if (display.stdout.trim()) {
        const recorded = join(evidence, `${name}.actual-entitlements.plist`); await write(recorded, display.stdout);
        entitlements = JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', recorded])).stdout);
      }
      requireAppSignature(display.stderr, entitlements, policy);
      return { metadata: display.stderr, entitlements };
    };
    const sign = async (policy, path) => {
      const basename = policy.identifier.replaceAll('.', '-'); const entitlements = join(evidence, `${basename}.entitlements.plist`);
      await write(entitlements, entitlementPlist(policy.entitlements));
      const unsigned = await checkedFile(path);
      await command('/usr/bin/codesign', appSigningArguments(options.identity, policy, path, entitlements));
      await command('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '--test-requirement', `=${developerIdRequirement(policy.identifier)}`, path]);
      const observed = await inspectSignature(policy, path);
      const signed = await checkedFile(path, { capture: true });
      const expected = deployment.find(binary => binary.path === policy.path);
      if (!isDeepStrictEqual(inspectMachO(signed.data), { minimumMacOS: expected.minimumMacOS, libraries: expected.libraries })) throw new Error('App signing changed executable deployment requirements.');
      staged.set(policy.path, { bytes: signed.bytes, sha256: signed.sha256 });
      signatures.push({ path: policy.path, identifier: policy.identifier, entitlements: observed.entitlements, unsigned, signed: { bytes: signed.bytes, sha256: signed.sha256 }, metadata: observed.metadata });
    };
    for (const policy of appExecutablePolicy) await sign(policy, join(app, policy.path));
    const node = join(app, 'Contents/MacOS/node');
    const nodeEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: context, TMPDIR: context };
    for (const name of ['cli.mjs', 'console-server.mjs']) await command(node, ['--check', join(app, 'Contents/Resources', name)], { env: nodeEnvironment });
    const smoke = await command(node, ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(JSON.stringify({version:process.versions.node,value:db.prepare('select 42 as value').get().value})); db.close();"], { env: nodeEnvironment });
    if (!isDeepStrictEqual(JSON.parse(smoke.stdout), { version: nodeDefinition.version, value: 42 })) throw new Error('The bundled signed Node did not pass its isolated SQLite check.');
    const releaseId = initialManifest.sha256;
    await resource('Contents/Resources/app-provenance.json', jsonBytes({ schemaVersion: 1, distributionReady: false, reproducibility: 'not-established',
      version: packageInput.version, minimumMacOS, runtime: { releaseId, signedTreeSha256: runtimeFingerprint, path: RUNTIME_PATH, compatibility: manifest.compatibility, deployment: runtimeDeployment },
      node: { definition: nodeDefinition, unsigned: nodeInputs[0].expected }, toolchain, sourceInputs: ordered([...sources.values()]),
      build: { cargo: { features: ['installed-runtime'], target: 'aarch64-apple-darwin', locked: true, profile: 'release', binaries: ['rat-things-desktop', 'rat-things'], deploymentTarget },
        javascript: { define: bundleOptions.define, target: bundleOptions.target, format: bundleOptions.format, legalComments: bundleOptions.legalComments,
          notices: { index: 'notices/javascript/index.json', sha256: digest(javascriptNotices.files[0].bytes) }, bundles: bundles.map(({ metafile: _metafile, ...bundle }) => bundle) } },
      deployment, executableSigningStage: 'before-application-seal',
      executables: signatures.map(({ metadata: _metadata, ...signature }) => signature), outstandingDistributionInputs: blockers }));
    await write(join(evidence, 'bundle-metafiles.json'), jsonBytes(bundles.map(bundle => ({ path: bundle.path, metafile: bundle.metafile }))));
    await write(join(evidence, 'runtime-inventory.json'), jsonBytes(originalRuntime));
    await write(join(evidence, 'input-inventory.json'), jsonBytes(ordered([...sources.values()])));
    for (const [filename, expected] of tracked) await checkedFile(filename, { expected });
    await javascriptNotices.verifyDirectories();
    const beforeSigning = (await appInventory(app)).filter(file => !signaturePaths.includes(file.path));
    if (!isDeepStrictEqual(beforeSigning.map(file => file.path).sort(), [...expectedPaths].sort())) throw new Error('App payload differs from its exact assembly inventory.');
    if (staged.size !== expectedPaths.size || beforeSigning.some(file =>
      !isDeepStrictEqual(staged.get(file.path), { bytes: file.bytes, sha256: file.sha256 }))) throw new Error('Staged app payload changed before application sealing.');
    const outerEntitlements = join(evidence, 'app.entitlements.plist'); await write(outerEntitlements, entitlementPlist([]));
    await chmod(join(app, 'Contents/Info.plist'), 0o644);
    await command('/usr/bin/codesign', appSigningArguments(options.identity, { identifier: APP_IDENTIFIER }, app, outerEntitlements));
    await chmod(join(app, 'Contents/Info.plist'), 0o444);
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '--test-requirement', `=${developerIdRequirement(APP_IDENTIFIER)}`, app]);
    const finalInventory = await appInventory(app);
    const desktopPath = 'Contents/MacOS/rat-things-desktop';
    if (!finalInventory.some(file => file.path === 'Contents/_CodeSignature/CodeResources')
      || finalInventory.some(file => !expectedPaths.has(file.path) && !signaturePaths.includes(file.path))
      || !isDeepStrictEqual(finalInventory.filter(file => expectedPaths.has(file.path) && file.path !== desktopPath), beforeSigning.filter(file => file.path !== desktopPath))) throw new Error('Outer app signing changed its nested executables or resources.');
    const outerDisplay = await inspectSignature({ identifier: APP_IDENTIFIER, entitlements: [] }, app, 'outer-app');
    if (nativeBundleFingerprint(await nativeBundleInventory(copiedRuntime)) !== runtimeFingerprint
      || nativeBundleFingerprint(await nativeBundleInventory(runtimeBundle)) !== runtimeFingerprint) throw new Error('Signing the app changed the signed runtime or its source.');
    await verifyRuntime(copiedRuntime);
    const launcher = await command(join(app, 'Contents/MacOS/rat-things'), ['--help'], { cwd: context, env: nodeEnvironment });
    if (!launcher.stdout.startsWith('Rat Things\n') || !launcher.stdout.includes('rat-things runtime')) throw new Error('The signed packaged CLI did not return its command help.');
    await write(join(evidence, 'signed-app-inventory.json'), jsonBytes(finalInventory));
    await write(join(evidence, 'signing.json'), jsonBytes({ identity: options.identity, team: 'PB8NAVKU57', signatures, outer: outerDisplay }));
    await write(join(evidence, 'commands.json'), jsonBytes(processEvidence));
    const result = { schemaVersion: 1, status: 'signed-app-candidate', distributionReady: false, reproducibility: 'not-established', app: 'Rat Things.app',
      minimumMacOS, runtime: { releaseId, signedTreeSha256: runtimeFingerprint }, appInventorySha256: digest(jsonBytes(finalInventory)), outstandingDistributionInputs: blockers };
    await write(join(output, 'app-build.json'), jsonBytes(result));
    return result;
  } catch (error) {
    await write(join(evidence, 'failed-commands.json'), jsonBytes(processEvidence));
    await write(join(output, 'failed-app-build.json'), jsonBytes({ status: 'failed', message: error.message }));
    throw error;
  } finally { await rm(context, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseNativeAppOptions(process.argv.slice(2));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Installed app assembly requires Apple silicon macOS with Xcode.');
  console.log(JSON.stringify({ output: options.output, ...await assembleNativeApp(options) }, null, 2));
}
