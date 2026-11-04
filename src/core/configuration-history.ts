import { createHash } from 'node:crypto';
import type { SessionState } from './session-ports.js';
import type { SessionConfiguration } from '../domain/configuration-history.js';
import type { AgentResource, AgentsStore, AgentObservation } from './agents-ports.js';
import type { ConfigurationMutation, ConfigurationRevision, ConfigurationRevisionRef, ConfigurationSnapshot, ConfigurationSubject, InspectionPage } from '../domain/configuration-history.js';
import { AgentsApiError, invalid, resourceNotFound } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';

export type ConfigurationWrite = { resource: AgentResource<unknown>; expectedRevision: number };
export const configurationRef = (subject: ConfigurationSubject, revision: number): ConfigurationRevisionRef => ({ subject, revision });
export const configurationCollection = (subject: ConfigurationSubject): string => `configuration_revisions/${subject.kind}/${subject.kind === 'credential' ? `${subject.vaultId}/` : ''}${subject.id}`;
export function configurationRevisionId(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('Invalid configuration revision', 'revision');
  return String(revision).padStart(16, '0');
}

/** Sorted JSON Pointer paths. Calculations never inspect a store or mutate either input. */
export function changedPaths(previous: unknown, next: unknown, path = ''): string[] {
  if (previous === undefined || next === undefined) return previous === next ? [] : [path || '/'];
  if (canonicalJson(previous) === canonicalJson(next)) return [];
  if (isRecord(previous) && isRecord(next)) return [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()
    .flatMap(key => changedPaths(previous[key], next[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  return [path || '/'];
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function planConfigurationRevision(ownerId: string, ref: ConfigurationRevisionRef, snapshot: ConfigurationSnapshot | null, previous: ConfigurationSnapshot | null, recordedAt: number, change: ConfigurationRevision['change'], mutation: ConfigurationMutation = {}): ConfigurationWrite {
  const id = configurationRevisionId(ref.revision);
  const value: ConfigurationRevision = {
    id, object: 'rat_things.configuration_revision', ref, recordedAt, change,
    actor: mutation.actor ?? { kind: 'owner', id: ownerId }, ...(mutation.requestId ? { requestId: mutation.requestId } : {}),
    digest: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), changedPaths: changedPaths(previous, snapshot), snapshot,
  };
  // All history rows have the same order timestamp, so cursors sort by source revision.
  return { resource: { ownerId, collection: configurationCollection(ref.subject), id, createdAt: 0, revision: 1, value }, expectedRevision: 0 };
}

/** Add an honest pre-upgrade observation to the same CAS transaction as the mutation. */
export async function missingConfigurationBaseline(store: AgentsStore, resource: AgentResource<unknown>, subject: ConfigurationSubject, snapshot: ConfigurationSnapshot, now: number): Promise<ConfigurationWrite[]> {
  const ref = configurationRef(subject, resource.revision);
  if (await store.get(resource.ownerId, configurationCollection(subject), configurationRevisionId(ref.revision))) return [];
  return [planConfigurationRevision(resource.ownerId, ref, snapshot, null, now, 'legacy_observed', { actor: { kind: 'unknown' } })];
}

/** Unknown acknowledgements are resolved only by the exact immutable bytes of this plan. */
export async function commitConfiguration(store: AgentsStore, writes: ConfigurationWrite[], evidence: ConfigurationWrite[], observations?: AgentObservation[], deleted?: AgentResource<unknown>): Promise<void> {
  try {
    if (deleted) await store.delete(deleted, writes);
    else await store.commit(writes, observations);
  } catch (error) {
    if (!evidence.length) throw error;
    // Safe history can be identical for two competing token rotations. Verify the
    // private heads as well, without copying their secret references into history.
    const retained = await Promise.all(writes.map(async ({ resource }) => {
      const stored = await store.get(resource.ownerId, resource.collection, resource.id);
      return stored?.revision === resource.revision && canonicalJson(stored.value) === canonicalJson(resource.value);
    })).catch(() => []);
    const removed = !deleted || await store.get(deleted.ownerId, deleted.collection, deleted.id).then(value => !value).catch(() => false);
    if (retained.length === writes.length && retained.every(Boolean) && removed) return;
    throw error;
  }
}

/** A reference is issued only after storage confirms the exact observed source revision. */
export async function retainConfiguration(store: AgentsStore, resource: AgentResource<unknown>, subject: ConfigurationSubject, snapshot: ConfigurationSnapshot, now: number): Promise<ConfigurationRevisionRef> {
  const writes = await missingConfigurationBaseline(store, resource, subject, snapshot, now);
  if (writes.length) await commitConfiguration(store, writes, writes, [{ ownerId: resource.ownerId, collection: resource.collection, id: resource.id, revision: resource.revision }]);
  return configurationRef(subject, resource.revision);
}

export const configurationConflict = (error: unknown): boolean => error instanceof AgentsApiError && error.status === 409 && error.code === 'conflict';

export class ConfigurationHistory {
  public constructor(private readonly store: AgentsStore) {}
  public async retrieve(ownerId: string, subject: ConfigurationSubject, revision: string | number): Promise<ConfigurationRevision> {
    if (typeof revision === 'string' && !/^\d{1,16}$/.test(revision)) invalid('Invalid configuration revision', 'revision');
    return (await this.store.get<ConfigurationRevision>(ownerId, configurationCollection(subject), configurationRevisionId(Number(revision))))?.value ?? resourceNotFound();
  }
  public async list(ownerId: string, subject: ConfigurationSubject, raw: unknown = {}): Promise<InspectionPage<ConfigurationRevision>> {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['after', 'limit', 'order'].includes(key))) invalid('Invalid history pagination');
    const { after, limit = 20, order = 'desc' } = raw;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer from 1 to 100', 'limit');
    if (order !== 'asc' && order !== 'desc') invalid('Invalid pagination order', 'order');
    if (after !== undefined && (typeof after !== 'string' || !/^\d{16}$/.test(after))) invalid('Invalid pagination cursor', 'after');
    const page = await this.store.list<ConfigurationRevision>(ownerId, configurationCollection(subject), { limit, order, ...(after ? { after } : {}) });
    const data = page.data.map(resource => resource.value);
    return { object: 'list', data, has_more: page.has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  }
}

export function sessionConfigurationSnapshot(state: SessionState, provenance: Pick<SessionConfiguration, 'sourceAgent' | 'sourceSession'> = {}): ConfigurationSnapshot {
  return { kind: 'session', configuration: { agent: state.session.agent, environment: state.session.environment,
    vaultIds: state.session.vault_ids, runtime: state.runtime ?? { kind: 'codex' },
    ...(state.importedFrom ? { importedFrom: { sessionId: state.importedFrom.sessionId } } : {}), ...provenance } };
}

/** Legacy admission is based only on retained Session settings, never today's saved Agent. */
export async function ensureSessionConfiguration(store: AgentsStore, initial: AgentResource<SessionState>, now: number): Promise<AgentResource<SessionState>> {
  let resource = initial;
  for (let attempt = 0; ; attempt++) {
    if (resource.value.configuration) return resource;
    const subject = { kind: 'session' as const, id: resource.id };
    const ref = configurationRef(subject, resource.revision);
    const baseline = await missingConfigurationBaseline(store, resource, subject, sessionConfigurationSnapshot(resource.value), now);
    const updated = { ...resource, revision: resource.revision + 1, value: { ...resource.value, configuration: { admitted: ref, current: ref } } };
    try {
      await commitConfiguration(store, [{ resource: updated, expectedRevision: resource.revision }, ...baseline], baseline);
      return updated;
    } catch (error) {
      if (!configurationConflict(error) || attempt >= 9) throw error;
      resource = await store.get<SessionState>(resource.ownerId, resource.collection, resource.id) ?? resourceNotFound();
    }
  }
}
