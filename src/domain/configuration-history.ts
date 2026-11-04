import type { Agent, AgentSession, Credential, Vault } from './agents-api.js';
import type { RuntimePin } from './session-runtime.js';

export type ConfigurationSubject =
  | { kind: 'agent'; id: string }
  | { kind: 'vault'; id: string }
  | { kind: 'credential'; vaultId: string; id: string }
  | { kind: 'session'; id: string };

export interface ConfigurationRevisionRef { subject: ConfigurationSubject; revision: number }
export type ConfigurationActor = { kind: 'owner'; id: string } | { kind: 'system' } | { kind: 'unknown' };
export interface ConfigurationMutation { actor?: ConfigurationActor; requestId?: string }

export interface SessionConfiguration {
  agent: AgentSession['agent'];
  environment: AgentSession['environment'];
  vaultIds: string[];
  runtime: RuntimePin;
  sourceAgent?: ConfigurationRevisionRef;
  sourceSession?: ConfigurationRevisionRef;
}

export type ConfigurationSnapshot =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'vault'; vault: Vault; status: 'active' | 'archived' }
  | { kind: 'credential'; credential: Credential; status: 'active' | 'archived' }
  | { kind: 'session'; configuration: SessionConfiguration };

/** Confidential configuration stays in encrypted storage, never in telemetry. */
export interface ConfigurationRevision {
  id: string;
  object: 'rat_things.configuration_revision';
  ref: ConfigurationRevisionRef;
  recordedAt: number;
  change: 'created' | 'updated' | 'deleted' | 'system' | 'legacy_observed';
  actor: ConfigurationActor;
  requestId?: string;
  digest: string;
  changedPaths: string[];
  snapshot: ConfigurationSnapshot | null;
}

export interface InspectionListParams { after?: string; limit?: number; order?: 'asc' | 'desc' }
export interface InspectionPage<T> { object: 'list'; data: T[]; has_more: boolean; first_id: string | null; last_id: string | null }
