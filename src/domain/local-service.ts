import type { NATIVE_PROTOCOL } from './native-protocol.js';
import type { NativeCompatibilityRequirements } from './native-release.js';

export type LocalServiceIdentity =
  | { readonly kind: 'development' }
  | { readonly kind: 'native'; readonly protocol: typeof NATIVE_PROTOCOL };

export function localServiceIdentity(requirements?: NativeCompatibilityRequirements): LocalServiceIdentity {
  if (!requirements) return { kind: 'development' };
  const { macOS: _macOS, ...protocol } = requirements;
  return { kind: 'native', protocol };
}

export function localServiceCompatible(required: LocalServiceIdentity, actual: unknown): boolean {
  if (!actual || typeof actual !== 'object' || !('kind' in actual) || actual.kind !== required.kind) return false;
  if (required.kind === 'development') return true;
  if (!('protocol' in actual) || !actual.protocol || typeof actual.protocol !== 'object') return false;
  const protocol = actual.protocol as Record<string, unknown>;
  return Object.entries(required.protocol).every(([key, value]) => protocol[key] === value);
}
