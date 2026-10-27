import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';
import { checkedFile } from './build-native-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Copy only an admitted official macOS artifact, including its original signatures. */
export async function stageDesktopCodexRuntime(artifactRoot, destination, admissionOptions = {}) {
  const artifact = await validateCodexRuntimeArtifact(artifactRoot, { ...admissionOptions, expectedTarget: 'aarch64-apple-darwin' });
  await mkdir(destination);
  for (const file of artifact.files) {
    const filename = join(destination, file.path);
    await mkdir(dirname(filename), { recursive: true });
    await checkedFile(file.source, { expected: file, destination: filename, mode: file.mode });
  }
  const runtime = { directory: destination, files: artifact.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })) };
  await verifyDesktopCodexRuntime(runtime);
  return runtime;
}

async function verifyDesktopCodexRuntime(runtime) {
  const paths = [];
  const visit = async (directory, prefix = '') => {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Desktop Codex directories must not be links.');
    const entries = await readdir(directory, { withFileTypes: true });
    if (!entries.length) throw new Error('Desktop Codex contains an unexpected empty directory.');
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Desktop Codex contains a link or special file.');
    }
  };
  await visit(runtime.directory);
  if (JSON.stringify(paths.sort()) !== JSON.stringify(runtime.files.map(file => file.path).sort())) throw new Error('Desktop Codex inventory changed.');
  for (const file of runtime.files) {
    const filename = join(runtime.directory, file.path);
    await checkedFile(filename, { expected: file });
    if (((await lstat(filename)).mode & 0o777) !== file.mode) throw new Error('Desktop Codex file permissions changed.');
  }
}

/**
 * Outer signing must leave every upstream executable and resource unchanged.
 * @param {string} bundle
 * @param {{ directory: string, files: Array<{path: string, sha256: string, mode: number}> }} runtime
 * @param {(command: string, args: string[], options: {stdio: 'inherit'}) => {status: number | null, error?: Error}} [run]
 */
export async function signDesktopBundle(bundle, runtime, run = spawnSync) {
  await verifyDesktopCodexRuntime(runtime);
  const signature = await run('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
  if (signature.error) throw signature.error;
  if (signature.status !== 0) throw new Error('Desktop application signing failed');
  await verifyDesktopCodexRuntime(runtime);
}

async function replaceExecutable(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function buildDesktop() {
  const metadata = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', 'desktop/Cargo.toml'], { cwd: root, encoding: 'utf8' });
  if (metadata.error) throw metadata.error;
  if (metadata.status !== 0) throw new Error(metadata.stderr || 'Could not locate Cargo output directory');
  const targetDirectory = JSON.parse(metadata.stdout).target_directory;
  const result = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', 'desktop/Cargo.toml'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const name = `rat-things-desktop${process.platform === 'win32' ? '.exe' : ''}`;
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await replaceExecutable(resolve(targetDirectory, 'release', name), resolve(root, 'dist', name));
  if (process.platform === 'darwin') {
    const bundle = resolve(root, 'dist/Rat Things.app/Contents');
    await mkdir(`${bundle}/MacOS`, { recursive: true });
    await mkdir(`${bundle}/Resources`, { recursive: true });
    await replaceExecutable(resolve(root, 'dist', name), `${bundle}/MacOS/${name}`);
    await replaceExecutable(process.execPath, `${bundle}/MacOS/node`);
    await chmod(`${bundle}/MacOS/node`, 0o755);
    await copyFile(resolve(root, 'dist/console-server.mjs'), `${bundle}/Resources/console-server.mjs`);
    await copyFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), `${bundle}/Resources/THIRD_PARTY_NOTICES.md`);
    await copyFile(resolve(root, 'assets/brand/rat-things.icns'), `${bundle}/Resources/AppIcon.icns`);
    const temporary = await mkdtemp(join(tmpdir(), 'rat-desktop-codex-'));
    let codex;
    try {
      const artifactRoot = join(temporary, 'artifact');
      const packaged = spawnSync(process.execPath, [resolve(root, 'scripts/build-codex-runtime.mjs'), artifactRoot], { cwd: root, stdio: 'inherit' });
      if (packaged.error) throw packaged.error;
      if (packaged.status !== 0) throw new Error('Official desktop Codex packaging failed');
      await rm(`${bundle}/MacOS/codex-runtime`, { recursive: true, force: true });
      await rm(`${bundle}/Resources/codex-runtime`, { recursive: true, force: true });
      codex = await stageDesktopCodexRuntime(artifactRoot, `${bundle}/Resources/codex-runtime`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    await cp(resolve(root, 'runtime/codex/licenses'), `${bundle}/Resources/codex-licenses`, { recursive: true });
    await writeFile(`${bundle}/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>dev.rat-things.console</string>
<key>CFBundleName</key><string>Rat Things</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
    await signDesktopBundle(resolve(bundle, '..'), codex);
    console.log('Built dist/Rat Things.app. Launch through rat-things console to inherit your API and AWS profile settings.');
  }
  console.log(`Built dist/${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDesktop();
