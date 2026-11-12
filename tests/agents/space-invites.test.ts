import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentObservation, AgentResource } from '../../src/core/agents-ports.js';
import { API_SCOPES, iamApiPrincipal, type ApiPrincipal } from '../../src/domain/api-permissions.js';
import { SpaceAccessService, spaceOwner, type SpaceInvite } from '../../src/identity/space-access.js';
import { GuardedAgentsStore } from '../../src/identity/guarded-agents-store.js';
import { oidcActorId } from '../../src/identity/principal.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

const issuer = 'https://id.example.test';
function principal(subject: string, kind: 'human' | 'workload' = 'human'): ApiPrincipal {
  return { ownerId: '', authentication: 'oidc', scopes: API_SCOPES, expiresAt: Date.now() + 60_000, actor: { id: oidcActorId(issuer, subject), kind, issuer, subject } };
}
function principalExpiringAt(subject: string, expiresAt: number): ApiPrincipal {
  return { ...principal(subject), expiresAt };
}
async function setup(now = () => Date.now(), base = new MemoryAgentsStore()) {
  const guardedStore = new GuardedAgentsStore(base);
  const access = new SpaceAccessService(guardedStore, now);
  const space = await access.bootstrap(iamApiPrincipal('operator'), { name: 'Design review', manager: { issuer, subject: 'alice' } });
  const authority = await access.authorize({ ...principal('alice'), expiresAt: now() + 3_600_000 }, space.id, ['manage_space']);
  return { base, guardedStore, access, space, authority };
}

class GatedInviteStore extends MemoryAgentsStore {
  public holdInviteRead?: () => Promise<void>;
  public holdRedeemCommit?: () => Promise<void>;
  public redeemObservations?: AgentObservation[];

  public override async get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined> {
    const value = await super.get<T>(ownerId, collection, id);
    if (collection === 'space_invites') await this.holdInviteRead?.();
    return value;
  }

  public override async commit(
    writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>,
    observations: AgentObservation[] = [],
  ): Promise<void> {
    if (writes.some(write => write.resource.collection === 'space_invites'
      && (write.resource.value as { status?: string }).status === 'redeemed')) {
      this.redeemObservations = structuredClone(observations);
      await this.holdRedeemCommit?.();
    }
    return super.commit(writes, observations);
  }
}

describe('space invite links', () => {
  it('admits the redeeming identity once with the invite role and stores only a hash of the secret', async () => {
    const s = await setup();
    const invite = await s.access.invite(s.authority, { role: 'collaborator', label: 'Sam' });
    expect(invite.token).toMatch(/^rti_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...s.base.resources.values()])).not.toContain(invite.token);
    expect(await s.base.get('rat:spaces', 'space_invite_tokens', createHash('sha256').update(invite.token).digest('hex'))).toBeDefined();
    await expect(s.access.authorize(principal('sam'), s.space.id, ['read'])).rejects.toThrow();

    expect(await s.access.redeem(principal('sam'), { token: invite.token })).toEqual({ space: { id: s.space.id, name: 'Design review' }, role: 'collaborator', joined: true });
    await expect(s.access.authorize(principal('sam'), s.space.id, ['contribute'])).resolves.toMatchObject({ role: 'collaborator', actor: { label: 'Sam' } });
    expect((await s.access.list(principal('sam'))).data).toMatchObject([{ id: s.space.id, role: 'collaborator' }]);

    await expect(s.access.redeem(principal('mallory'), { token: invite.token })).rejects.toMatchObject({ status: 404 });
    await expect(s.access.authorize(principal('mallory'), s.space.id, ['read'])).rejects.toThrow();
    expect((await s.access.invites(s.authority)).data).toEqual([]);
  });

  it('lets only one of two concurrent redemptions win', async () => {
    const s = await setup();
    const { token } = await s.access.invite(s.authority, { role: 'viewer' });
    const results = await Promise.allSettled([s.access.redeem(principal('sam'), { token }), s.access.redeem(principal('mallory'), { token })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 404 } });
  });

  it('refuses manager invites, expired or revoked links, workloads and non-OIDC callers', async () => {
    let clock = Date.now();
    const s = await setup(() => clock);
    await expect(s.access.invite(s.authority, { role: 'manager' })).rejects.toMatchObject({ status: 400 });
    await expect(s.access.invite(s.authority, { role: 'viewer', expires_in: 8 * 86400 })).rejects.toMatchObject({ status: 400 });
    await expect(s.access.invite(s.authority, { role: 'viewer', space_id: 'other' })).rejects.toMatchObject({ status: 400 });

    const expiring = await s.access.invite(s.authority, { role: 'viewer', expires_in: 300 });
    clock += 301_000;
    await expect(s.access.redeem({ ...principal('sam'), expiresAt: clock + 60_000 }, { token: expiring.token })).rejects.toMatchObject({ status: 404 });
    clock = Date.now();

    const revoked = await s.access.invite(s.authority, { role: 'viewer' });
    expect((await s.access.invites(s.authority)).data.map(invite => invite.id)).toContain(revoked.id);
    await s.access.revokeInvite(s.authority, revoked.id);
    expect((await s.access.invites(s.authority)).data.map(invite => invite.id)).not.toContain(revoked.id);
    await expect(s.access.redeem(principal('sam'), { token: revoked.token })).rejects.toMatchObject({ status: 404 });

    const open = await s.access.invite(s.authority, { role: 'viewer' });
    await expect(s.access.redeem(principal('robot', 'workload'), { token: open.token })).rejects.toMatchObject({ status: 403 });
    await expect(s.access.redeem({ ...iamApiPrincipal('operator') }, { token: open.token })).rejects.toMatchObject({ status: 403 });
    await expect(s.access.redeem({ ...principal('sam'), scopes: ['api.responses.write'] }, { token: open.token })).rejects.toMatchObject({ status: 403 });
    await expect(s.access.redeem(principal('sam'), { token: 'rti_guess' })).rejects.toMatchObject({ status: 404 });
    expect(await s.access.redeem(principal('sam'), { token: open.token })).toMatchObject({ joined: true });
  });

  it('never lowers an existing role and leaves the invite usable for someone else', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'controller', label: 'Bob' });
    const viewer = await s.access.invite(s.authority, { role: 'viewer' });
    expect(await s.access.redeem(principal('bob'), { token: viewer.token })).toMatchObject({ role: 'controller', joined: false });
    expect(await s.access.redeem(principal('sam'), { token: viewer.token })).toMatchObject({ role: 'viewer', joined: true });

    await s.access.bind(s.authority, { issuer, subject: 'carol', role: 'viewer', label: 'Carol', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const upgrade = await s.access.invite(s.authority, { role: 'collaborator' });
    expect(await s.access.redeem(principal('carol'), { token: upgrade.token })).toMatchObject({ role: 'collaborator', joined: true });
    const carol = (await s.access.bindings(s.authority)).data.find(binding => binding.subject === 'carol');
    expect(carol).toMatchObject({ role: 'collaborator', label: 'Carol', expires_at: expect.any(Number) });
  });

  it('caps open invites per space', async () => {
    const s = await setup();
    for (let index = 0; index < 50; index++) await s.access.invite(s.authority, { role: 'viewer' });
    await expect(s.access.invite(s.authority, { role: 'viewer' })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps the active invite limit under concurrent minting', async () => {
    const s = await setup();
    for (let index = 0; index < 49; index++) await s.access.invite(s.authority, { role: 'viewer' });

    const results = await Promise.allSettled([
      s.access.invite(s.authority, { role: 'viewer' }),
      s.access.invite(s.authority, { role: 'viewer' }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await s.access.invites(s.authority)).data).toHaveLength(50);
  });

  it('lists and counts open invites beyond closed invite history', async () => {
    let clock = Date.now();
    const s = await setup(() => clock);
    const oldestOpen = await s.access.invite(s.authority, { role: 'viewer' });
    for (let index = 0; index < 100; index++) {
      clock += 1_000;
      const closed = await s.access.invite(s.authority, { role: 'viewer' });
      await s.access.revokeInvite(s.authority, closed.id);
    }
    for (let index = 0; index < 49; index++) {
      clock += 1_000;
      await s.access.invite(s.authority, { role: 'viewer' });
    }

    const listed = await s.access.invites(s.authority);
    expect(listed.data.map(invite => invite.id)).toHaveLength(50);
    expect(listed.data.map(invite => invite.id)).toContain(oldestOpen.id);
    expect(listed.has_more).toBe(false);
    await expect(s.access.invite(s.authority, { role: 'viewer' })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects redemption when the principal expires during invite reads', async () => {
    const originalDateNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    const store = new GatedInviteStore();
    try {
      const s = await setup(() => clock, store);
      const invite = await s.access.invite(s.authority, { role: 'viewer' });
      const expiresAt = clock + 100;
      let releaseRead!: () => void;
      let readStarted!: () => void;
      const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      const readEntered = new Promise<void>(resolve => { readStarted = resolve; });
      store.holdInviteRead = async () => { readStarted(); await readGate; };

      const redemption = s.access.redeem(principalExpiringAt('sam', expiresAt), { token: invite.token });
      await readEntered;
      clock = expiresAt;
      releaseRead();

      await expect(redemption).rejects.toMatchObject({ status: 401 });
      await expect(s.access.authorize(principal('sam'), s.space.id, ['read'])).rejects.toMatchObject({ status: 403 });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('fences redemption commit with the principal expiry', async () => {
    const originalDateNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    const store = new GatedInviteStore();
    try {
      const s = await setup(() => clock, store);
      const invite = await s.access.invite(s.authority, { role: 'viewer' });
      const expiresAt = clock + 100;
      let releaseCommit!: () => void;
      let commitStarted!: () => void;
      const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
      const commitEntered = new Promise<void>(resolve => { commitStarted = resolve; });
      store.holdRedeemCommit = async () => { commitStarted(); await commitGate; };

      const redemption = s.access.redeem(principalExpiringAt('sam', expiresAt), { token: invite.token });
      await commitEntered;
      clock = expiresAt;
      releaseCommit();

      await expect(redemption).rejects.toMatchObject({ status: 401 });
      expect(store.redeemObservations).toEqual(expect.arrayContaining([expect.objectContaining({ validUntil: expiresAt })]));
      await expect(s.access.authorize(principal('sam'), s.space.id, ['read'])).rejects.toMatchObject({ status: 403 });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('keeps an invite unusable when it expires before redemption commits', async () => {
    const originalDateNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    const store = new GatedInviteStore();
    try {
      const s = await setup(() => clock, store);
      const invite = await s.access.invite(s.authority, { role: 'viewer', expires_in: 300 });
      const principalExpiry = clock + 600_000;
      let releaseCommit!: () => void;
      let commitStarted!: () => void;
      const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
      const commitEntered = new Promise<void>(resolve => { commitStarted = resolve; });
      store.holdRedeemCommit = async () => { commitStarted(); await commitGate; };

      const redemption = s.access.redeem(principalExpiringAt('sam', principalExpiry), { token: invite.token });
      await commitEntered;
      clock = invite.expires_at * 1000;
      releaseCommit();

      await expect(redemption).rejects.toMatchObject({ status: 404 });
      await expect(store.get<SpaceInvite>(spaceOwner(s.space.id), 'space_invites', invite.id))
        .resolves.toMatchObject({ value: { status: 'active' } });
      await expect(s.access.authorize(principal('sam'), s.space.id, ['read'])).rejects.toMatchObject({ status: 403 });
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe('invite routes', () => {
  it('restricts invite management to managers and redeems without a selected space', async () => {
    const setupResult = await setup();
    const s = { ...setupResult, agents: new AgentService({ store: setupResult.guardedStore }) };
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'collaborator' });
    const request = (path: string, method: string, body?: unknown, space?: string) => new Request(`https://api.test${path}`, {
      method, headers: { ...(space ? { 'x-rat-space': space } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const invites = `/v1/rat/spaces/${s.space.id}/invites`;
    expect((await routeAgentsRequest(request(invites, 'POST', { role: 'viewer' }, s.space.id), principal('bob'), s)).status).toBe(403);
    expect((await routeAgentsRequest(request(invites, 'GET', undefined, s.space.id), principal('bob'), s)).status).toBe(403);

    const created = await routeAgentsRequest(request(invites, 'POST', { role: 'collaborator' }, s.space.id), principal('alice'), s);
    expect(created.status).toBe(201);
    const { id, token } = await created.json() as { id: string; token: string };
    const listed = await (await routeAgentsRequest(request(invites, 'GET', undefined, s.space.id), principal('alice'), s)).json() as { data: unknown[] };
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed.data).toMatchObject([{ id, role: 'collaborator', status: 'active' }]);

    const redeemed = await routeAgentsRequest(request('/v1/rat/invites/redeem', 'POST', { token }), principal('sam'), s);
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({ space: { id: s.space.id }, role: 'collaborator' });
    expect((await routeAgentsRequest(request('/v1/rat/spaces', 'GET'), principal('sam'), s)).status).toBe(200);

    const second = await (await routeAgentsRequest(request(invites, 'POST', { role: 'viewer' }, s.space.id), principal('alice'), s)).json() as { id: string; token: string };
    expect((await routeAgentsRequest(request(`${invites}/${second.id}`, 'DELETE', undefined, s.space.id), principal('alice'), s)).status).toBe(200);
    expect((await routeAgentsRequest(request('/v1/rat/invites/redeem', 'POST', { token: second.token }), principal('dana'), s)).status).toBe(404);
  });
});
