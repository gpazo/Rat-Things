export interface EnvironmentIdentity { ownerId: string; environmentId: string; role: 'executor' | 'harness' }

export function environmentToken(identity: EnvironmentIdentity, entropy: string): string {
  return `ratenv.${Buffer.from(JSON.stringify(identity)).toString('base64url')}.${entropy}`;
}

/** Decoding identifies the credential to verify; it never authenticates the caller. */
export function environmentTokenIdentity(token: string): EnvironmentIdentity | undefined {
  if (token.length > 4096) return undefined;
  const [prefix, payload, entropy, extra] = token.split('.');
  if (prefix !== 'ratenv' || !payload || !entropy || extra !== undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null || !('ownerId' in value) || !('environmentId' in value) || !('role' in value)) return undefined;
    if (typeof value.ownerId !== 'string' || !value.ownerId || typeof value.environmentId !== 'string' || !/^env_[a-zA-Z0-9]+$/.test(value.environmentId) || !['executor', 'harness'].includes(String(value.role))) return undefined;
    return { ownerId: value.ownerId, environmentId: value.environmentId, role: value.role as EnvironmentIdentity['role'] };
  } catch { return undefined; }
}
