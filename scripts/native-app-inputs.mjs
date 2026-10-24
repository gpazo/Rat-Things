import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const APP_IDENTIFIER = 'dev.rat-things.console';
export const RUNTIME_PATH = 'Contents/Resources/Runtime.bundle';
export const appExecutablePolicy = Object.freeze([
  { path: 'Contents/MacOS/node', identifier: `${APP_IDENTIFIER}.node`, entitlements: ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'] },
  { path: 'Contents/Helpers/rat-runtime-verifier', identifier: `${APP_IDENTIFIER}.runtime-verifier`, entitlements: [] },
  { path: 'Contents/Helpers/rat-native-recovery', identifier: `${APP_IDENTIFIER}.native-recovery`, entitlements: ['com.apple.security.virtualization'] },
  { path: 'Contents/MacOS/rat-things', identifier: `${APP_IDENTIFIER}.cli`, entitlements: [] },
  { path: 'Contents/MacOS/rat-things-desktop', identifier: APP_IDENTIFIER, entitlements: [] },
]);

export function parseNativeAppOptions(args) {
  const names = ['runtime-bundle', 'node-input-directory', 'identity', 'output'];
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !names.includes(name) || name in options || !value || value.startsWith('--')) {
      throw new Error('Native app options must be explicit, unique name/value pairs.');
    }
    options[name] = value;
  }
  if (names.some(name => !options[name])) throw new Error(`Required options: ${names.map(name => `--${name}`).join(', ')}.`);
  if (!/^Developer ID Application: [^\r\n]+ \(PB8NAVKU57\)$/.test(options.identity)) throw new Error('An explicit Developer ID Application identity for team PB8NAVKU57 is required.');
  return { runtimeBundle: resolve(options['runtime-bundle']), nodeInputDirectory: resolve(options['node-input-directory']),
    identity: options.identity, output: resolve(options.output) };
}

export function requireNodeDefinition(value, recordedInput, checksums) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!value || !/^\d+\.\d+\.\d+$/.test(value.version) || value.target !== 'aarch64-apple-darwin'
    || !hash(value.archiveSha256) || !hash(value.checksumsSha256)
    || value.url !== `https://nodejs.org/dist/v${value.version}/node-v${value.version}-darwin-arm64.tar.gz`
    || value.checksumsURL !== `https://nodejs.org/dist/v${value.version}/SHASUMS256.txt`
    || !isDeepStrictEqual(Object.keys(value.files ?? {}).sort(), ['LICENSE', 'bin/node'])
    || Object.values(value.files).some(file => !hash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 192 * 1024 ** 2)
    || !isDeepStrictEqual(value, recordedInput)) throw new Error('Node input does not match the maintained ARM64 Node definition.');
  const archive = `node-v${value.version}-darwin-arm64.tar.gz`;
  const matches = checksums.trim().split(/\r?\n/).filter(line => line.endsWith(`  ${archive}`));
  if (matches.length !== 1 || matches[0] !== `${value.archiveSha256}  ${archive}`) throw new Error('Node checksum publication does not contain the locked archive.');
  return [{ source: 'node', target: 'Contents/MacOS/node', expected: value.files['bin/node'], maximumBytes: 192 * 1024 ** 2, mode: 0o755 },
    { source: 'LICENSE', target: 'Contents/Resources/notices/node-LICENSE', expected: value.files.LICENSE, maximumBytes: 2 * 1024 ** 2, mode: 0o444 },
    { source: archive, expected: { sha256: value.archiveSha256 }, maximumBytes: 128 * 1024 ** 2 },
    { source: 'SHASUMS256.txt', expected: { sha256: value.checksumsSha256 }, maximumBytes: 1024 * 1024 }];
}

export function maximumMacOS(versions) {
  if (!versions.length || versions.some(version => typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(version))) {
    throw new Error('A measured macOS deployment version is required for every executable.');
  }
  return [...versions].sort((left, right) => {
    const a = left.split('.').map(Number); const b = right.split('.').map(Number);
    return a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
  }).at(-1);
}

export function appInfoPlist(version, minimumMacOS) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The app package version must have three numeric components.');
  maximumMacOS([minimumMacOS]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>rat-things-desktop</string>
<key>CFBundleIdentifier</key><string>${APP_IDENTIFIER}</string>
<key>CFBundleName</key><string>Rat Things</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`;
}

export const entitlementPlist = keys => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>\n`;

export function appSigningArguments(identity, policy, filename, entitlementPath) {
  return ['--force', '--sign', identity, '--identifier', policy.identifier, '--options', 'runtime', '--timestamp', '--entitlements', entitlementPath, filename];
}

export const developerIdRequirement = identifier => `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "PB8NAVKU57"`;

export function requireAppSignature(metadata, entitlements, policy) {
  const values = metadata.split(/\r?\n/);
  if (!values.includes('TeamIdentifier=PB8NAVKU57') || !values.includes(`Identifier=${policy.identifier}`)
    || !values.some(line => /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(line))
    || !values.some(line => /^Timestamp=.+/.test(line))
    || !isDeepStrictEqual(entitlements, Object.fromEntries(policy.entitlements.map(key => [key, true])))) {
    throw new Error(`App executable has an unexpected signature or entitlement set: ${policy.identifier}.`);
  }
}
