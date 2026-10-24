import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LocalNativeBundleVerifier, NATIVE_VERIFIER_LIMITS } from '../adapters/local-native-verifier.js';
import { NATIVE_PROTOCOL } from '../domain/native-protocol.js';
import { LocalNativeReleaseProbe } from '../runner/local-native-probe.js';
import type { LocalNativeServiceOptions } from './local-native-service.js';
import type { LocalServiceIdentity } from '../domain/local-service.js';

declare const __RAT_THINGS_INSTALLED__: boolean;
export const installedRuntime = typeof __RAT_THINGS_INSTALLED__ !== 'undefined' && __RAT_THINGS_INSTALLED__;
export const installedServiceIdentity: LocalServiceIdentity | undefined = installedRuntime
  ? { kind: 'native', protocol: NATIVE_PROTOCOL } : undefined;

export interface InstalledPaths {
  readonly resources: string;
  readonly bundledRuntime: string;
  readonly verifier: string;
  readonly recovery: string;
  readonly desktop: string;
}

export function installedPaths(moduleURL: string, executable: string): InstalledPaths {
  const script = fileURLToPath(moduleURL);
  const resources = dirname(script);
  const contents = dirname(resources);
  const bundle = dirname(contents);
  if (!['cli.mjs', 'console-server.mjs'].includes(basename(script)) || basename(resources) !== 'Resources'
    || basename(contents) !== 'Contents' || !bundle.endsWith('.app')
    || resolve(executable) !== join(contents, 'MacOS/node')) {
    throw new Error('Run the installed Rat Things app or its bundled command-line launcher.');
  }
  return { resources, bundledRuntime: join(resources, 'Runtime.bundle'),
    verifier: join(contents, 'Helpers/rat-runtime-verifier'), recovery: join(contents, 'Helpers/rat-native-recovery'),
    desktop: join(contents, 'MacOS/rat-things-desktop') };
}

export async function installedNativeOptions(): Promise<{ readonly native?: LocalNativeServiceOptions }> {
  if (!installedRuntime) return {};
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The installed runtime requires an Apple silicon Mac.');
  for (const name of Object.keys(process.env)) {
    if (['CODEX_BINARY', 'RAT_THINGS_CONSOLE_SERVER', 'RAT_THINGS_CONSOLE_NODE', 'RAT_THINGS_CONSOLE_BIN'].includes(name)
      || name.startsWith('RAT_NATIVE_')) throw new Error(`The installed app does not accept the executable override ${name}.`);
  }
  const paths = installedPaths(import.meta.url, process.execPath);
  for (const path of [process.execPath, paths.verifier, paths.recovery, paths.bundledRuntime]) {
    const state = await lstat(path);
    if (state.isSymbolicLink() || await realpath(path) !== path
      || (path === paths.bundledRuntime ? !state.isDirectory() : !state.isFile())) {
      throw new Error('The installed Rat Things app has an invalid resource.');
    }
  }
  const { stdout } = await promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8', env: {}, timeout: 5000, maxBuffer: 1024,
  });
  const macOS = stdout.trim();
  if (!/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(macOS)) throw new Error('Could not read the macOS version.');
  return { native: {
    bundledRuntimePath: paths.bundledRuntime,
    verifier: new LocalNativeBundleVerifier({ trustedExecutable: paths.verifier }),
    probe: runtime => new LocalNativeReleaseProbe({ runtime, trustedRecoveryExecutable: paths.recovery }),
    requirements: { ...NATIVE_PROTOCOL, macOS }, limits: NATIVE_VERIFIER_LIMITS,
  } };
}
