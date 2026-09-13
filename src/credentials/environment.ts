/** Connection keys authorize exactly one environment and one side of its relay. */
export interface EnvironmentCredentials {
  executor: string;
  harness: string;
}

export interface EnvironmentCredentialStore {
  create(ownerId: string, environmentId: string): Promise<string>;
  read(reference: string): Promise<EnvironmentCredentials>;
  revoke(reference: string): Promise<void>;
}

export interface EnvironmentIdentity { ownerId: string; environmentId: string; role: 'executor' | 'harness' }

export function parseEnvironmentCredentials(raw: string): EnvironmentCredentials {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('executor' in value) || !('harness' in value) || typeof value.executor !== 'string' || typeof value.harness !== 'string') throw new Error('Invalid environment credentials');
  return { executor: value.executor, harness: value.harness };
}

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
