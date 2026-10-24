import type { NativeInstallationFailure, NativeReleaseId, NativeReleaseManifest, NativeSelection, NativeVerificationFailure } from '../domain/native-release.js';
import type { NativeRuntimeChangeIntent, NativeRuntimeChangePhase } from '../domain/local-native-change.js';

/** Supplied by the existing SQLite server lease owner. It grants no second lease or independent CLI writer. */
export interface NativeInstallationLease {
  readonly profileDirectory: string;
  assertHeld(): void;
  /** Retain the acquired SQLite lease until work settles. Shutdown must wait; this must not acquire another lock. */
  runWhileHeld<T>(work: () => Promise<T>): Promise<T>;
}

export interface NativeCopyLimits {
  /** Includes directories. Recovery applies one shared budget across temporary trees. */
  readonly entries: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly manifestBytes: number;
  readonly depth: number;
  readonly pathBytes: number;
}

export type NativeBundleVerification =
  | { readonly kind: 'authenticated'; readonly manifestBytes: Uint8Array;
      readonly executablePaths: readonly string[] }
  | { readonly kind: 'rejected'; readonly failure: NativeVerificationFailure };

/**
 * Production must use the signed desktop's fixed Security.framework policy. Authenticate the outer
 * bundle as dev.rat-things.runtime from team PB8NAVKU57 before reading the manifest, then separately
 * validate every executable against host-owned identifiers and the same team. Verify all sealed
 * resources, all architectures and nested code. Do not accept an ad-hoc signature, skip-resource
 * flags, bundle-provided signer policy, a cached success, or a verifier inside the candidate bundle.
 * Return the exact authenticated manifest bytes and the complete independently validated executable
 * path set. This port is a trust boundary; its success cannot be reconstructed from checksums.
 * Its implementation owns a finite subprocess deadline and reaps the verifier before settling.
 */
export interface NativeBundleVerifier {
  verify(input: { readonly bundlePath: string; readonly limits: NativeCopyLimits }): Promise<NativeBundleVerification>;
}

export interface PinnedNativeRelease {
  readonly id: NativeReleaseId;
  readonly bundlePath: string;
  readonly manifest: NativeReleaseManifest;
  readonly helperPath: string;
  readonly hostCodexPath: string;
}

export type NativeProbeResult = { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly failure: Extract<NativeInstallationFailure, { kind: 'probe' }> };

/** The probe owns only disposable disks under directory, shares VM admission, and never opens account or Session data. */
export interface NativeReleaseProbe {
  /** Lock and dispose exact bound orphan probe disks before installer metadata cleanup. Never use PID recovery. */
  recover(input: { readonly directory: string }): Promise<NativeProbeResult>;
  /** Enforce a finite deadline. Return only after children stop and disk handles and the VM reservation are released. */
  run(input: { readonly release: PinnedNativeRelease; readonly directory: string }): Promise<NativeProbeResult>;
  /** Stop accepted probe work. Reject while any owned child exit remains unconfirmed so its owner retains the lease. */
  close(): Promise<void>;
}

export type NativeInstallationChange =
  | { readonly kind: 'none' }
  | { readonly kind: 'working'; readonly operation: 'startup' | 'setup' | 'rollback'; readonly phase: NativeRuntimeChangePhase }
  | { readonly kind: 'awaiting_restart'; readonly release: NativeReleaseId }
  | { readonly kind: 'failed'; readonly failure: NativeInstallationFailure };
export interface NativeInstallationStatus {
  readonly selection: NativeSelection;
  readonly selectionKnown: boolean;
  readonly selected: PinnedNativeRelease | null;
  readonly change: NativeInstallationChange;
}

export interface NativeInstallationHooks {
  readonly beforeMutation?: (intent: NativeRuntimeChangeIntent) => Promise<void>;
  readonly progress?: (phase: NativeRuntimeChangePhase) => void | Promise<void>;
}

export type NativeInstallCheckpoint = 'copied-file' | 'staging-synced' | 'copy-verified'
  | 'version-renamed' | 'version-parent-synced' | 'probe-ready'
  | 'selection-file-synced' | 'selection-renamed' | 'selection-parent-synced';
