import { createHash } from 'node:crypto';
import { LocalContainerRuntime } from '../adapters/local-container-runtime.js';
import { LocalNativeRuntime } from '../adapters/local-native-runtime.js';
import { isAbsolute, join } from 'node:path';
import type { LocalRuntime } from '../core/local-runtime-ports.js';

export function createLocalRuntime(directory: string): LocalRuntime {
  const assets = process.env.RAT_THINGS_LINUX_KVM_RUNTIME;
  if (assets !== undefined) {
    if (process.platform !== 'linux' || process.arch !== 'x64' || !isAbsolute(assets)) throw new Error('RAT_THINGS_LINUX_KVM_RUNTIME requires an absolute asset directory on x86-64 Linux');
    return new LocalNativeRuntime(directory, () => ({ kind: 'linux-kvm-development', directory: assets }), { developmentStorage: 'linux-kvm-workspaces' });
  }
  return new LocalContainerRuntime(createHash('sha256').update(directory).digest('hex').slice(0, 16), join(directory, 'container-engine.json'));
}
