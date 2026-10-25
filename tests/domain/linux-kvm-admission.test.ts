import { expect, it } from 'vitest';
import { linuxKvmAdmission, nativeAdmission, nativeHostFacts, type NativeAdmissionInput } from '../../src/domain/local-native-admission.js';

const input: NativeAdmissionInput = {
  facts: { supported: true, architecture: 'x64', physicalMemoryBytes: 16 * 1024 ** 3,
    minimumCPUCount: 1, maximumCPUCount: 8, minimumMemoryBytes: 512 * 1024 ** 2, maximumMemoryBytes: 16 * 1024 ** 3, memoryPressure: 'normal' },
  requestedCPUCount: 1, slotAvailable: true, availableDiskBytes: 4 * 1024 ** 3, requiredDiskBytes: 1024 ** 3,
};

it('admits explicit Linux KVM capacity without widening Apple virtualization admission', () => {
  expect(linuxKvmAdmission(input)).toMatchObject({ kind: 'admitted', effectiveCapacity: 1, resources: { cpuCount: 1, memoryMiB: 2048 } });
  expect(nativeAdmission(input)).toMatchObject({ kind: 'unsupported' });
  expect(linuxKvmAdmission({ ...input, facts: { ...input.facts, architecture: 'arm64' } })).toMatchObject({ kind: 'unsupported' });
});

it('fails closed for unsupported virtualization and insufficient host memory', () => {
  expect(linuxKvmAdmission({ ...input, facts: { ...input.facts, supported: false } })).toMatchObject({ kind: 'unsupported' });
  expect(linuxKvmAdmission({ ...input, facts: { ...input.facts, physicalMemoryBytes: 4 * 1024 ** 3 } })).toMatchObject({ kind: 'unsupported' });
  expect(linuxKvmAdmission({ ...input, requestedCPUCount: 2 })).toMatchObject({ kind: 'unsupported' });
});

it('queues work while capacity or memory pressure prevents safe execution', () => {
  expect(linuxKvmAdmission({ ...input, slotAvailable: false })).toMatchObject({ kind: 'wait', code: 'local_capacity' });
  expect(linuxKvmAdmission({ ...input, availableDiskBytes: 0 })).toMatchObject({ kind: 'wait', code: 'local_disk_capacity' });
  for (const memoryPressure of ['critical', 'unknown'] as const) {
    expect(linuxKvmAdmission({ ...input, facts: { ...input.facts, memoryPressure } })).toMatchObject({ kind: 'wait', code: 'local_memory_pressure' });
  }
});

it('reserves additional VM memory only when allocating a new worker', () => {
  const occupied = { ...input, facts: { ...input.facts, availableMemoryBytes: 9 * 1024 ** 3 } };
  expect(linuxKvmAdmission(occupied)).toMatchObject({ kind: 'wait', code: 'local_memory_pressure' });
  expect(linuxKvmAdmission({ ...occupied, existingAllocation: true })).toMatchObject({ kind: 'admitted' });
  expect(linuxKvmAdmission({ ...occupied, existingAllocation: true, facts: { ...occupied.facts, availableMemoryBytes: 7 * 1024 ** 3 } }))
    .toMatchObject({ kind: 'wait', code: 'local_memory_pressure' });
  expect(linuxKvmAdmission({ ...occupied, existingAllocation: true, slotAvailable: false })).toMatchObject({ kind: 'wait', code: 'local_capacity' });
});

it('validates optional Linux available memory without requiring it from the Apple helper', () => {
  expect(nativeHostFacts({ ...input.facts, memoryPressure: 1 })).not.toHaveProperty('availableMemoryBytes');
  expect(nativeHostFacts({ ...input.facts, memoryPressure: 1, availableMemoryBytes: 5 * 1024 ** 3 })).toHaveProperty('availableMemoryBytes', 5 * 1024 ** 3);
  expect(() => nativeHostFacts({ ...input.facts, memoryPressure: 1, availableMemoryBytes: -1 })).toThrow('Invalid native host facts');
});
