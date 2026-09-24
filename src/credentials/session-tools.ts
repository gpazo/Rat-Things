import type { EnvironmentCredentialAuth } from '../domain/environment-credential-planning.js';
import { parseAgentsContract } from '../domain/agents-api-validation.js';
import { validateCredentialAuth } from '../domain/vault-planning.js';

/** Confidential values never appear in public configuration or launch manifests. */
export interface SessionToolSecret {
  ownerId: string;
  sessionId: string;
  serverLabel: string;
  headers: Record<string, string>;
  env: Record<string, string>;
}

export interface SessionEnvironmentSecret {
  ownerId: string;
  sessionId: string;
  environmentId: string;
  credentials: EnvironmentCredentialAuth[];
}
export type SessionCredentialSecret = SessionToolSecret | SessionEnvironmentSecret;
export type SessionCredentialIdentity = Pick<SessionToolSecret, 'ownerId' | 'sessionId' | 'serverLabel'> | Pick<SessionEnvironmentSecret, 'ownerId' | 'sessionId' | 'environmentId'>;

export interface SessionToolSecrets {
  /** Pure reservation: persist this reference before attempting creation. */
  reference(identity: SessionCredentialIdentity, attemptId: string): string;
  create(secret: SessionCredentialSecret, reference: string): Promise<void>;
  /** Retire even an uncertain creation; retries must be safe. */
  revoke(reference: string): Promise<void>;
}

export function parseSessionEnvironmentSecret(raw: string, identity: Pick<SessionEnvironmentSecret, 'ownerId' | 'sessionId' | 'environmentId'>): SessionEnvironmentSecret {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.ownerId !== identity.ownerId || value.sessionId !== identity.sessionId || value.environmentId !== identity.environmentId || !Array.isArray(value.credentials)) throw new Error('Session environment credential identity is invalid');
  const credentials = value.credentials.map(auth => {
    const parsed = parseAgentsContract('CredentialCreate', { name: 'snapshot', auth }).auth;
    if (parsed.type !== 'environment_variable') throw new Error('Invalid environment credential snapshot');
    validateCredentialAuth(parsed);
    return parsed;
  });
  return { ...identity, credentials };
}

export function parseSessionToolSecret(raw: string, identity: Pick<SessionToolSecret, 'ownerId' | 'sessionId' | 'serverLabel'>): SessionToolSecret {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.ownerId !== identity.ownerId || value.sessionId !== identity.sessionId || value.serverLabel !== identity.serverLabel || !strings(value.headers) || !strings(value.env)) throw new Error('Session tool credential identity is invalid');
  return { ...identity, headers: value.headers, env: value.env };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function strings(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every((part) => typeof part === 'string'); }
