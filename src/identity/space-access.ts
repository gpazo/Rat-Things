import { randomUUID } from 'node:crypto';
import type { AgentObservation, AgentResource, AgentsStore } from '../core/agents-ports.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import { SPACE_ROLES, requireSpaceActions, rolePermissions, type ApiActor, type ApiPrincipal, type SpaceAction, type SpaceRole } from '../domain/api-permissions.js';
import { oidcActorId, principalActor, requireUnexpired } from './principal.js';

const DIRECTORY = 'rat:spaces';
export interface Space { id: string; name: string; active: boolean }
export interface SpaceBinding { actor_id: string; issuer: string; subject: string; kind: 'human' | 'workload'; label?: string; role: SpaceRole; expires_at?: number; active: boolean }
export interface SpaceAuthority {
  ownerId: string;
  spaceId: string;
  actor: ApiActor;
  role: SpaceRole;
  observations: AgentObservation[];
  expiresAt?: number;
  permissions: SpaceAction[];
  revalidate(): Promise<void>;
}
export function spaceOwner(spaceId: string): string { return `rat:space:${spaceId}`; }
export function observation(resource: AgentResource<unknown>): AgentObservation {
  return { ownerId: resource.ownerId, collection: resource.collection, id: resource.id, revision: resource.revision };
}
export class SpaceAccessService {
  public constructor(public readonly store: AgentsStore, private readonly now: () => number = Date.now) {}
  public async authorize(principal: ApiPrincipal, spaceId: string, actions: readonly SpaceAction[]): Promise<SpaceAuthority> {
    requireUnexpired(principal, this.now());
    const actor = principalActor(principal);
    if (!actor.issuer || !actor.subject || actor.id !== oidcActorId(actor.issuer, actor.subject)) denied();
    const [space, binding] = await Promise.all([
      this.store.get<Space>(DIRECTORY, 'spaces', spaceId), this.store.get<SpaceBinding>(spaceOwner(spaceId), 'space_bindings', actor.id),
    ]);
    if (!space?.value.active || !binding?.value.active || binding.value.issuer !== actor.issuer || binding.value.subject !== actor.subject || binding.value.kind !== actor.kind) denied();
    const expiresAt = Math.min(principal.expiresAt ?? Infinity, binding.value.expires_at === undefined ? Infinity : binding.value.expires_at * 1000);
    requireUnexpired({ expiresAt }, this.now());
    requireSpaceActions(principal, binding.value.role, actions);
    return { ownerId: spaceOwner(spaceId), spaceId, actor: { ...actor, ...(binding.value.label ? { label: binding.value.label } : {}) }, role: binding.value.role,
      observations: [observation(space), observation(binding)].map(value => ({ ...value, ...(Number.isFinite(expiresAt) ? { validUntil: expiresAt } : {}) })), ...(Number.isFinite(expiresAt) ? { expiresAt } : {}), permissions: rolePermissions(binding.value.role).filter(action => { try { requireSpaceActions(principal, binding.value.role, [action]); return true; } catch { return false; } }),
      revalidate: async () => { await this.authorize(principal, spaceId, actions); } };
  }
  public async list(principal: ApiPrincipal) {
    requireUnexpired(principal, this.now());
    const actor = principalActor(principal);
    const data: Array<Space & { role: SpaceRole; permissions: SpaceAction[] }> = [];
    let after: string | undefined;
    do {
      const page = await this.store.list<{ space_id: string }>(actor.id, 'space_discovery', { limit: 100, ...(after ? { after } : {}) });
      for (const item of page.data) {
        try {
          const authority = await this.authorize(principal, item.value.space_id, ['read']);
          const space = await this.store.get<Space>(DIRECTORY, 'spaces', authority.spaceId);
          if (space) data.push({ ...space.value, role: authority.role, permissions: authority.permissions });
        } catch (error) { if (!(error instanceof AgentsApiError) || ![401, 403].includes(error.status)) throw error; }
      }
      if (!page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    return { data, has_more: false };
  }
  public async bootstrap(principal: ApiPrincipal, raw: unknown): Promise<Space> {
    if (principal.authentication !== 'iam') denied();
    requireUnexpired(principal, this.now());
    const input = record(raw, ['name', 'manager']);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128) invalid('A space name is required.', 'name');
    const binding = parseBinding({ ...record(input.manager, ['issuer', 'subject', 'label', 'kind']), role: 'manager' });
    if (binding.kind !== 'human') invalid('The initial manager must be human.', 'manager');
    const space: Space = { id: `space_${randomUUID().replaceAll('-', '')}`, name: input.name, active: true };
    const now = Math.floor(this.now() / 1000);
    await this.store.commit([
      { resource: { ownerId: DIRECTORY, collection: 'spaces', id: space.id, revision: 1, createdAt: now, value: space }, expectedRevision: 0 },
      { resource: { ownerId: spaceOwner(space.id), collection: 'space_bindings', id: binding.actor_id, revision: 1, createdAt: now, value: binding }, expectedRevision: 0 },
      { resource: { ownerId: binding.actor_id, collection: 'space_discovery', id: space.id, revision: 1, createdAt: now, value: { space_id: space.id } }, expectedRevision: 0 },
    ]);
    return space;
  }
  public async accept(authority: SpaceAuthority, actions: readonly SpaceAction[], path: string): Promise<void> {
    await authority.revalidate(); requireUnexpired(authority, this.now());
    const now = Math.floor(this.now() / 1000);
    await this.store.commit([{ resource: { ownerId: authority.ownerId, collection: 'request_acceptances', id: randomUUID(), createdAt: now, revision: 1, expiresAt: now + 4 * 86400,
      value: { actor: authority.actor, actions, path, accepted_at: now } }, expectedRevision: 0 }], authority.observations);
  }
  public async bindings(authority: SpaceAuthority) {
    const records = await this.store.list<SpaceBinding>(authority.ownerId, 'space_bindings', { limit: 100 });
    return { data: records.data.filter(item => item.value.active).map(item => item.value), has_more: records.has_more };
  }
  public async bind(authority: SpaceAuthority, raw: unknown) {
    const binding = parseBinding(raw);
    const previous = await this.store.get(authority.ownerId, 'space_bindings', binding.actor_id);
    const index = await this.store.get(binding.actor_id, 'space_discovery', authority.spaceId);
    const now = Math.floor(this.now() / 1000);
    await authority.revalidate(); requireUnexpired(authority, this.now());
    const writes = [
      { resource: { ownerId: authority.ownerId, collection: 'space_bindings', id: binding.actor_id, createdAt: previous?.createdAt ?? now, revision: (previous?.revision ?? 0) + 1, value: binding }, expectedRevision: previous?.revision ?? 0 },
      { resource: { ownerId: binding.actor_id, collection: 'space_discovery', id: authority.spaceId, createdAt: index?.createdAt ?? now, revision: (index?.revision ?? 0) + 1, value: { space_id: authority.spaceId } }, expectedRevision: index?.revision ?? 0 },
    ];
    await this.store.commit(writes, excludingWrites(authority.observations, writes.map(w => w.resource)));
    return binding;
  }
  public async revoke(authority: SpaceAuthority, actorId: string) {
    const previous = await this.store.get<SpaceBinding>(authority.ownerId, 'space_bindings', actorId);
    if (!previous) throw new AgentsApiError(404, 'Binding not found.', 'resource_not_found');
    await authority.revalidate(); requireUnexpired(authority, this.now());
    await this.store.commit([{ resource: { ...previous, revision: previous.revision + 1, value: { ...previous.value, active: false } }, expectedRevision: previous.revision }], excludingWrites(authority.observations, [previous]));
    return { actor_id: actorId, revoked: true };
  }
}
export function excludingWrites(observations: readonly AgentObservation[], resources: readonly Pick<AgentResource<unknown>, 'ownerId' | 'collection' | 'id'>[]): AgentObservation[] {
  return observations.filter(o => !resources.some(r => r.ownerId === o.ownerId && r.collection === o.collection && r.id === o.id));
}
function parseBinding(raw: unknown): SpaceBinding {
  const input = record(raw, ['issuer', 'subject', 'role', 'expires_at', 'label', 'kind']);
  if (typeof input.issuer !== 'string' || typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 1024) invalid('Exact issuer and subject are required.');
  let issuer: URL; try { issuer = new URL(input.issuer); } catch { return invalid('Invalid issuer.'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search) invalid('Issuer must be HTTPS.');
  if (!SPACE_ROLES.includes(input.role as SpaceRole)) invalid('Unknown space role.', 'role');
  if (input.kind !== undefined && input.kind !== 'human' && input.kind !== 'workload') invalid('Unknown principal kind.', 'kind');
  if (input.expires_at !== undefined && (typeof input.expires_at !== 'number' || !Number.isSafeInteger(input.expires_at) || input.expires_at <= 0)) invalid('Invalid membership expiry.', 'expires_at');
  if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 128)) invalid('Invalid actor label.', 'label');
  return { actor_id: oidcActorId(input.issuer, input.subject), issuer: input.issuer, subject: input.subject, role: input.role as SpaceRole,
    kind: input.kind === 'workload' ? 'workload' : 'human', active: true,
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at as number } : {}), ...(input.label ? { label: input.label as string } : {}) };
}
export function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('Expected an object.');
  if (Object.keys(raw).some(key => !allowed.includes(key))) invalid('Unknown field.');
  return raw as Record<string, unknown>;
}
function denied(): never { throw new AgentsApiError(403, 'Current space membership is required.', 'insufficient_permissions'); }
