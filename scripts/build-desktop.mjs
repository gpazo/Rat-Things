import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function replaceExecutable(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
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
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const runtime = resolve(root, `node_modules/@openai/codex-darwin-${process.arch}/vendor/${target}`);
  const descriptor = JSON.parse(await readFile(`${runtime}/codex-package.json`, 'utf8'));
  const source = JSON.parse(await readFile(resolve(root, 'runtime/codex/source.json'), 'utf8'));
  if (descriptor.version !== source.upstreamVersion || descriptor.target !== target) throw new Error('The bundled host Codex must match the pinned runtime version');
  await rm(`${bundle}/MacOS/codex-runtime`, { recursive: true, force: true });
  await rm(`${bundle}/Resources/codex-runtime`, { recursive: true, force: true });
  await cp(runtime, `${bundle}/Resources/codex-runtime`, { recursive: true });
  await cp(resolve(root, 'runtime/codex/licenses'), `${bundle}/Resources/codex-licenses`, { recursive: true });
  for (const executable of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/zsh/bin/zsh']) {
    const signature = spawnSync('codesign', ['--force', '--sign', '-', `${bundle}/Resources/codex-runtime/${executable}`], { stdio: 'inherit' });
    if (signature.error) throw signature.error;
    if (signature.status !== 0) process.exit(signature.status ?? 1);
  }
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
  const signature = spawnSync('codesign', ['--force', '--sign', '-', resolve(bundle, '..')], { stdio: 'inherit' });
  if (signature.error) throw signature.error;
  if (signature.status !== 0) process.exit(signature.status ?? 1);
  console.log('Built dist/Rat Things.app. Launch through rat-things console to inherit your API and AWS profile settings.');
}
console.log(`Built dist/${name}`);
