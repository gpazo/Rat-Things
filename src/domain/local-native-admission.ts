const GiB = 1024 ** 3;

export type NativeMemoryPressure = 'normal' | 'warning' | 'critical' | 'unknown';
export interface NativeHostFacts {
  supported: boolean;
  architecture: string;
  physicalMemoryBytes: number;
  availableMemoryBytes?: number;
  minimumCPUCount: number;
  maximumCPUCount: number;
  minimumMemoryBytes: number;
  maximumMemoryBytes: number;
  memoryPressure: NativeMemoryPressure;
}
export interface NativeResources { cpuCount: 1; memoryMiB: 2048; budgetBytes: number; hostReserveBytes: number }
export type NativeAdmission =
  | { kind: 'admitted'; effectiveCapacity: 1; resources: NativeResources }
  | { kind: 'wait'; effectiveCapacity: 1; code: 'local_capacity' | 'local_memory_pressure' | 'local_disk_capacity'; message: string }
  | { kind: 'unsupported'; effectiveCapacity: 0; code: 'local_native_unsupported'; message: string };
export type NativeAdmissionRefusal = Exclude<NativeAdmission, { kind: 'admitted' }>;
export interface NativeAdmissionInput {
  facts: NativeHostFacts; requestedCPUCount: number; slotAvailable: boolean; availableDiskBytes: number; requiredDiskBytes: number;
  existingAllocation?: boolean;
}

export class LocalRuntimeAdmissionError extends Error {
  constructor(readonly decision: NativeAdmissionRefusal) { super(decision.message); }
}

export function nativeMemoryPressure(dispatchLevel: unknown): NativeMemoryPressure {
  switch (dispatchLevel) {
    case 1: return 'normal';
    case 2: return 'warning';
    case 4: return 'critical';
    default: return 'unknown';
  }
}

export function nativeHostFacts(input: unknown): NativeHostFacts {
  if (!input || typeof input !== 'object') throw new Error('Invalid native host facts');
  const value = input as Record<string, unknown>;
  if (typeof value.supported !== 'boolean' || typeof value.architecture !== 'string') throw new Error('Invalid native host facts');
  const integer = (name: string) => {
    const number = value[name];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new Error('Invalid native host facts');
    return number;
  };
  return { supported: value.supported, architecture: value.architecture,
    physicalMemoryBytes: integer('physicalMemoryBytes'), minimumCPUCount: integer('minimumCPUCount'), maximumCPUCount: integer('maximumCPUCount'),
    ...(value.availableMemoryBytes === undefined ? {} : { availableMemoryBytes: integer('availableMemoryBytes') }),
    minimumMemoryBytes: integer('minimumMemoryBytes'), maximumMemoryBytes: integer('maximumMemoryBytes'), memoryPressure: nativeMemoryPressure(value.memoryPressure) };
}

export function nativeAdmission(input: NativeAdmissionInput): NativeAdmission {
  const { facts } = input;
  const memoryBytes = 2 * GiB;
  const hostReserveBytes = Math.max(4 * GiB, facts.physicalMemoryBytes / 2);
  if (!facts.supported || facts.architecture !== 'arm64' || input.requestedCPUCount !== 1
    || facts.minimumCPUCount > 1 || facts.maximumCPUCount < 1
    || facts.minimumMemoryBytes > memoryBytes || facts.maximumMemoryBytes < memoryBytes
    || facts.physicalMemoryBytes < 8 * GiB || facts.physicalMemoryBytes - hostReserveBytes < 3 * GiB) {
    return { kind: 'unsupported', effectiveCapacity: 0, code: 'local_native_unsupported',
      message: 'Native workers require Apple silicon virtualization, at least 8 GiB of host memory, and support for one CPU and 2 GiB of guest memory.' };
  }
  if (facts.memoryPressure === 'unknown' || facts.memoryPressure === 'critical') return {
    kind: 'wait', effectiveCapacity: 1, code: 'local_memory_pressure', message: facts.memoryPressure === 'critical'
      ? 'Native work is queued while this Mac has critical memory pressure.' : 'Native work is queued because this Mac\'s memory pressure is unavailable.',
  };
  if (!input.slotAvailable) return { kind: 'wait', effectiveCapacity: 1, code: 'local_capacity', message: 'The native worker slot is in use. Work stays queued until it is free.' };
  if (input.availableDiskBytes < input.requiredDiskBytes) return { kind: 'wait', effectiveCapacity: 1, code: 'local_disk_capacity',
    message: `Native work needs ${input.requiredDiskBytes} bytes on the profile filesystem; ${input.availableDiskBytes} bytes are available.` };
  return { kind: 'admitted', effectiveCapacity: 1, resources: { cpuCount: 1, memoryMiB: 2048, budgetBytes: 3 * GiB, hostReserveBytes } };
}

export function linuxKvmAdmission(input: NativeAdmissionInput): NativeAdmission {
  const { facts } = input;
  const hostReserveBytes = Math.max(4 * GiB, facts.physicalMemoryBytes / 2);
  if (!facts.supported || facts.architecture !== 'x64' || input.requestedCPUCount !== 1
    || facts.minimumCPUCount > 1 || facts.maximumCPUCount < 1
    || facts.minimumMemoryBytes > 2 * GiB || facts.maximumMemoryBytes < 2 * GiB
    || facts.physicalMemoryBytes < 8 * GiB || facts.physicalMemoryBytes - hostReserveBytes < 3 * GiB) {
    return { kind: 'unsupported', effectiveCapacity: 0, code: 'local_native_unsupported',
      message: 'Linux development workers require x86-64 KVM, private VM sockets, user resource controls and at least 8 GiB of host memory.' };
  }
  if (facts.memoryPressure === 'unknown' || facts.memoryPressure === 'critical'
    || facts.availableMemoryBytes !== undefined && facts.availableMemoryBytes < hostReserveBytes + (input.existingAllocation ? 0 : 3 * GiB)) return {
    kind: 'wait', effectiveCapacity: 1, code: 'local_memory_pressure', message: 'Linux work is queued while available host memory cannot safely accommodate a worker.',
  };
  if (!input.slotAvailable) return { kind: 'wait', effectiveCapacity: 1, code: 'local_capacity', message: 'The Linux worker slot is in use. Work stays queued until it is free.' };
  if (input.availableDiskBytes < input.requiredDiskBytes) return { kind: 'wait', effectiveCapacity: 1, code: 'local_disk_capacity',
    message: `Linux work needs ${input.requiredDiskBytes} bytes on the profile filesystem; ${input.availableDiskBytes} bytes are available.` };
  return { kind: 'admitted', effectiveCapacity: 1, resources: { cpuCount: 1, memoryMiB: 2048, budgetBytes: 3 * GiB, hostReserveBytes } };
}
