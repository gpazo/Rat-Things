export interface NativeProbeLimits {
  readonly directories: number;
  readonly diskBytes: number;
  readonly metadataBytes: number;
  readonly logBytes: number;
  readonly entries: number;
  readonly depth: number;
}

export const NATIVE_PROBE_LIMITS: NativeProbeLimits = Object.freeze({
  directories: 16, diskBytes: 256 * 1024 ** 2, metadataBytes: 16 * 1024 ** 2,
  logBytes: 1024 ** 2, entries: 512, depth: 8,
});
