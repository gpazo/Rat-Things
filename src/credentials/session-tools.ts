/** Confidential values never appear in public configuration or launch manifests. */
export interface SessionToolSecret {
  ownerId: string;
  sessionId: string;
  serverLabel: string;
  headers: Record<string, string>;
  env: Record<string, string>;
}

export interface SessionToolSecrets {
  /** Pure reservation: persist this reference before attempting creation. */
  reference(identity: Pick<SessionToolSecret, 'ownerId' | 'sessionId' | 'serverLabel'>, attemptId: string): string;
  create(secret: SessionToolSecret, reference: string): Promise<void>;
  /** Retire even an uncertain creation; retries must be safe. */
  revoke(reference: string): Promise<void>;
}

export function parseSessionToolSecret(raw: string, identity: Pick<SessionToolSecret, 'ownerId' | 'sessionId' | 'serverLabel'>): SessionToolSecret {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.ownerId !== identity.ownerId || value.sessionId !== identity.sessionId || value.serverLabel !== identity.serverLabel || !strings(value.headers) || !strings(value.env)) throw new Error('Session tool credential identity is invalid');
  return { ...identity, headers: value.headers, env: value.env };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function strings(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every((part) => typeof part === 'string'); }
