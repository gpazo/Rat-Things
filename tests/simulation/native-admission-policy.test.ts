import { expect, it } from 'vitest';
import { nativeAdmission, nativeHostFacts, nativeMemoryPressure } from '../../src/domain/local-native-admission.js';
import { supportedHost } from './native-runtime-fixtures.js';

const input = { facts: supportedHost, requestedCPUCount: 1, slotAvailable: true, availableDiskBytes: 256 * 1024 ** 2, requiredDiskBytes: 256 * 1024 ** 2 };

it('admits one CPU and 2 GiB on an 8 GiB host with a 4 GiB host reserve and 3 GiB VM budget', () => {
  expect(nativeAdmission(input)).toEqual({ kind: 'admitted', effectiveCapacity: 1,
    resources: { cpuCount: 1, memoryMiB: 2048, budgetBytes: 3 * 1024 ** 3, hostReserveBytes: 4 * 1024 ** 3 } });
  expect(nativeAdmission({ ...input, facts: { ...supportedHost, physicalMemoryBytes: 32 * 1024 ** 3 } })).toMatchObject({ resources: { hostReserveBytes: 16 * 1024 ** 3 } });
});

it.each([
  { physicalMemoryBytes: 8 * 1024 ** 3 - 1 }, { supported: false }, { architecture: 'x86_64' },
  { minimumCPUCount: 2 }, { maximumCPUCount: 0 }, { minimumMemoryBytes: 2 * 1024 ** 3 + 1 }, { maximumMemoryBytes: 2 * 1024 ** 3 - 1 },
])('rejects unsupported host capabilities without offering effective capacity', facts => {
  expect(nativeAdmission({ ...input, facts: { ...supportedHost, ...facts } })).toMatchObject({ kind: 'unsupported', effectiveCapacity: 0 });
});

it('rejects two CPUs under the one-CPU admission policy', () => {
  expect(nativeAdmission({ ...input, requestedCPUCount: 2 })).toMatchObject({ kind: 'unsupported', effectiveCapacity: 0 });
});

it('reads Dispatch pressure values and fails closed on missing or unknown values', () => {
  expect([1, 2, 4].map(nativeMemoryPressure)).toEqual(['normal', 'warning', 'critical']);
  for (const value of [undefined, null, 0, 3, 5, '1', -1]) expect(nativeMemoryPressure(value)).toBe('unknown');
  const parsed = nativeHostFacts({ ...supportedHost, memoryPressure: 4 });
  expect(nativeAdmission({ ...input, facts: parsed })).toMatchObject({ kind: 'wait', code: 'local_memory_pressure' });
  for (const pressure of ['unknown', 'critical'] as const) expect(nativeAdmission({ ...input, facts: { ...supportedHost, memoryPressure: pressure } })).toMatchObject({ kind: 'wait', code: 'local_memory_pressure' });
  expect(nativeAdmission({ ...input, facts: { ...supportedHost, memoryPressure: 'warning' } }).kind).toBe('admitted');
  expect(() => nativeHostFacts({ ...supportedHost, physicalMemoryBytes: NaN })).toThrow();
});

it('waits for an occupied slot or insufficient space and admits the exact space boundary', () => {
  expect(nativeAdmission({ ...input, slotAvailable: false })).toMatchObject({ kind: 'wait', code: 'local_capacity' });
  expect(nativeAdmission({ ...input, availableDiskBytes: input.requiredDiskBytes - 1 })).toMatchObject({ kind: 'wait', code: 'local_disk_capacity' });
  expect(nativeAdmission(input).kind).toBe('admitted');
});
