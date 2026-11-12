import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentObservation, AgentResource, AgentsStore } from '../core/agents-ports.js';
import { AgentsApiError, AgentsResourceConflictError, invalid } from '../domain/agents-api-validation.js';
import { SPACE_ROLES, requireSpaceActions, rolePermissions, type ApiActor, type ApiPrincipal, type SpaceAction, type SpaceRole } from '../domain/api-permissions.js';
import { oidcActorId, principalActor, requireUnexpired } from './principal.js';
import { performanceCount, performancePhase } from '../core/performance.js';
import {
  ACTIVE_INVITE_LIMIT, INVITE_GENERATIONS, isActiveSpaceInvite, planInviteGeneration,
  type SpaceInvite, type SpaceInviteGeneration,
} from './space-invite-planning.js';

const DIRECTORY = 'rat:spaces';
export interface Space { id: string; name: string; active: boolean }
export interface SpaceBinding { actor_id: string; issuer: string; subject: string; kind: 'human' | 'workload'; label?: string; role: SpaceRole; expires_at?: number; active: boolean }
export type { SpaceInvite } from './space-invite-planning.js';
type InviteRole = SpaceInvite['role'];
const INVITE_ROLES: readonly InviteRole[] = ['viewer', 'collaborator', 'controller'];
const INVITE_TOKEN = /^rti_[A-Za-z0-9_-]{43}$/;
const INVITE_MAX_SECONDS = 7 * 86400;
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
    performanceCount('AuthorizationCount');
    return performancePhase('AuthorizationDuration', () => this.resolveAuthority(principal, spaceId, actions));
  }
  private async resolveAuthority(principal: ApiPrincipal, spaceId: string, actions: readonly SpaceAction[]): Promise<SpaceAuthority> {
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
    if (principal.authentication !== 'iam' || !principal.scopes.includes('api.agents.write')) denied();
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
  /** Returns the secret once. Anyone holding it can join once with the invite's role. */
  public async invite(authority: SpaceAuthority, raw: unknown): Promise<SpaceInvite & { token: string }> {
    const input = record(raw, ['role', 'label', 'expires_in']);
    if (!INVITE_ROLES.includes(input.role as InviteRole)) invalid('Invite links grant viewer, collaborator or controller. Grant manager to a verified identity.', 'role');
    if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 128)) invalid('Invalid invite label.', 'label');
    const seconds = input.expires_in ?? INVITE_MAX_SECONDS;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 300 || seconds > INVITE_MAX_SECONDS) invalid('Invites expire after 5 minutes to 7 days.', 'expires_in');
    const generation = await this.store.get<SpaceInviteGeneration>(authority.ownerId, INVITE_GENERATIONS, 'active');
    const records = await listAll<SpaceInvite>(this.store, authority.ownerId, 'space_invites');
    const now = Math.floor(this.now() / 1000);
    const openCount = records.reduce((count, item) => count + Number(isActiveSpaceInvite(item.value, now)), 0);
    if (openCount >= ACTIVE_INVITE_LIMIT) {
      throw new AgentsApiError(409, `A space can have at most ${ACTIVE_INVITE_LIMIT} open invites. Revoke unused invites first.`, 'conflict');
    }
    const token = `rti_${randomBytes(32).toString('base64url')}`;
    const invite: SpaceInvite = { id: `inv_${randomUUID().replaceAll('-', '')}`, space_id: authority.spaceId, role: input.role as InviteRole,
      ...(input.label ? { label: input.label as string } : {}), created_by: authority.actor.id, created_at: now, expires_at: now + seconds, status: 'active' };
    const retainUntil = invite.expires_at + INVITE_MAX_SECONDS;
    await authority.revalidate(); requireUnexpired(authority, this.now());
    const nextGeneration = planInviteGeneration(authority.ownerId, authority.spaceId, now, generation);
    const writes = [
      { resource: nextGeneration.resource, expectedRevision: nextGeneration.expectedRevision },
      { resource: { ownerId: authority.ownerId, collection: 'space_invites', id: invite.id, revision: 1, createdAt: now, expiresAt: retainUntil, value: invite }, expectedRevision: 0 },
      { resource: { ownerId: DIRECTORY, collection: 'space_invite_tokens', id: inviteKey(token), revision: 1, createdAt: now, expiresAt: retainUntil,
        value: { space_id: invite.space_id, invite_id: invite.id } }, expectedRevision: 0 },
    ];
    await this.store.commit(writes, excludingWrites(authority.observations, writes.map(w => w.resource)));
    return { ...invite, token };
  }
  public async invites(authority: SpaceAuthority) {
    const records = await listAll<SpaceInvite>(this.store, authority.ownerId, 'space_invites');
    const now = Math.floor(this.now() / 1000);
    return { data: records.map(item => item.value).filter(invite => isActiveSpaceInvite(invite, now)), has_more: false };
  }
  public async revokeInvite(authority: SpaceAuthority, inviteId: string) {
    const previous = await this.store.get<SpaceInvite>(authority.ownerId, 'space_invites', inviteId);
    if (!previous) throw new AgentsApiError(404, 'Invite not found.', 'resource_not_found');
    await authority.revalidate(); requireUnexpired(authority, this.now());
    if (previous.value.status === 'active') {
      await this.store.commit([{ resource: { ...previous, revision: previous.revision + 1, value: { ...previous.value, status: 'revoked' } }, expectedRevision: previous.revision }],
        excludingWrites(authority.observations, [previous]));
    }
    return { id: inviteId, revoked: true };
  }
  /**
   * Binds the caller's verified identity with the invite's role. Invites admit people only;
   * workloads still need an explicit binding. An invite never lowers an existing role.
   */
  public async redeem(principal: ApiPrincipal, raw: unknown) {
    requireUnexpired(principal, this.now());
    const actor = principalActor(principal);
    if (principal.authentication !== 'oidc' || actor.kind !== 'human' || !actor.issuer || !actor.subject || actor.id !== oidcActorId(actor.issuer, actor.subject)) {
      throw new AgentsApiError(403, 'Sign in with a verified team identity to use an invite.', 'insufficient_permissions');
    }
    if (!principal.scopes.includes('api.agents.read')) throw new AgentsApiError(403, 'This sign-in cannot read team resources.', 'insufficient_permissions');
    const input = record(raw, ['token']);
    if (typeof input.token !== 'string' || !INVITE_TOKEN.test(input.token)) unavailable();
    const index = await this.store.get<{ space_id: string; invite_id: string }>(DIRECTORY, 'space_invite_tokens', inviteKey(input.token));
    if (!index) unavailable();
    const owner = spaceOwner(index.value.space_id);
    const [space, invite, previous, discovery] = await Promise.all([
      this.store.get<Space>(DIRECTORY, 'spaces', index.value.space_id), this.store.get<SpaceInvite>(owner, 'space_invites', index.value.invite_id),
      this.store.get<SpaceBinding>(owner, 'space_bindings', actor.id), this.store.get(actor.id, 'space_discovery', index.value.space_id),
    ]);
    requireUnexpired(principal, this.now());
    const now = Math.floor(this.now() / 1000);
    if (!space?.value.active || !invite || invite.value.space_id !== space.id || !isActiveSpaceInvite(invite.value, now)) unavailable();
    if (previous?.value.active && previous.value.kind !== 'human') throw new AgentsApiError(409, 'This identity is registered as a workload in the space.', 'conflict');
    const current = previous?.value.active && previous.value.issuer === actor.issuer && previous.value.subject === actor.subject
      && (previous.value.expires_at === undefined || previous.value.expires_at > now) ? previous.value : undefined;
    const summary = { id: space.id, name: space.value.name };
    if (current && SPACE_ROLES.indexOf(current.role) >= SPACE_ROLES.indexOf(invite.value.role)) return { space: summary, role: current.role, joined: false };
    const label = previous?.value.label ?? invite.value.label ?? actor.label?.trim().slice(0, 128);
    const binding: SpaceBinding = { actor_id: actor.id, issuer: actor.issuer, subject: actor.subject, kind: 'human', role: invite.value.role, active: true,
      ...(current?.expires_at !== undefined ? { expires_at: current.expires_at } : {}), ...(label ? { label } : {}) };
    const redemptionValidUntil = Math.min(principal.expiresAt ?? Infinity, invite.value.expires_at * 1000);
    try {
      await this.store.commit([
        { resource: { ownerId: owner, collection: 'space_bindings', id: actor.id, createdAt: previous?.createdAt ?? now, revision: (previous?.revision ?? 0) + 1, value: binding }, expectedRevision: previous?.revision ?? 0 },
        { resource: { ownerId: actor.id, collection: 'space_discovery', id: space.id, createdAt: discovery?.createdAt ?? now, revision: (discovery?.revision ?? 0) + 1, value: { space_id: space.id } }, expectedRevision: discovery?.revision ?? 0 },
        { resource: { ...invite, revision: invite.revision + 1, value: { ...invite.value, status: 'redeemed', redeemed_by: actor.id, redeemed_at: now } }, expectedRevision: invite.revision },
      ], [{ ...observation(space), validUntil: redemptionValidUntil }]);
    } catch (error) {
      if (error instanceof AgentsResourceConflictError) unavailable();
      if (error instanceof AgentsApiError && error.status === 401) {
        requireUnexpired(principal, this.now());
        if (invite.value.expires_at * 1000 <= this.now()) unavailable();
      }
      throw error;
    }
    return { space: summary, role: binding.role, joined: true };
  }
}
async function listAll<T>(store: AgentsStore, ownerId: string, collection: string): Promise<Array<AgentResource<T>>> {
  const records: Array<AgentResource<T>> = [];
  let after: string | undefined;
  do {
    const page = await store.list<T>(ownerId, collection, { limit: 100, ...(after ? { after } : {}) });
    records.push(...page.data);
    if (!page.has_more) return records;
    const last = page.data.at(-1);
    if (!last) throw new Error('Storage returned an empty page with more records.');
    after = last.id;
  } while (after);
  return records;
}
function inviteKey(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function unavailable(): never { throw new AgentsApiError(404, 'This invite link is invalid, expired or already used. Ask for a new one.', 'resource_not_found'); }
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
