import { resolve } from 'node:path';
import { LocalNativeRuntime, type NativeRuntimeDependencies } from '../../../../src/adapters/local-native-runtime.js';

export function nativeProofCpuCount(value: string | undefined): 1 {
  if (value === undefined || value === '1') return 1;
  if (value === '2') throw new Error('Two-CPU native workers are unsupported while guest kernel faults remain unresolved. Use one CPU.');
  throw new Error('Native proof CPU count must be 1');
}

export class NativeProofRuntime extends LocalNativeRuntime {
  constructor(directory: string, assets = resolve('.runtime/local-vm-worker'), cpuCount: 1 = 1, dependencies: NativeRuntimeDependencies = {}) {
    super(directory, () => ({ kind: 'development-assets', directory: assets }), { cpuCount, dependencies, developmentStorage: 'native-proof' });
  }
}
