import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { API_SCOPES, iamApiPrincipal, type ApiPrincipal } from '../../src/domain/api-permissions.js';
import { SpaceAccessService } from '../../src/identity/space-access.js';
import { oidcActorId } from '../../src/identity/principal.js';

it('preserves invite capacity across independent SQLite connections and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-invite-capacity-'));
  const issuer = 'https://identity.example';
  const manager: ApiPrincipal = { ownerId: '', authentication: 'oidc', scopes: API_SCOPES,
    expiresAt: Date.now() + 60_000, actor: { id: oidcActorId(issuer, 'manager'), kind: 'human', issuer, subject: 'manager' } };
  const stores: SqliteAgentsStore[] = [];
  const connect = () => {
    const store = new SqliteAgentsStore(directory);
    stores.push(store);
    return new SpaceAccessService(store);
  };
  try {
    const first = connect();
    const space = await first.bootstrap(iamApiPrincipal('operator'), { name: 'Capacity', manager: { issuer, subject: 'manager' } });
    const second = connect();
    const a = await first.authorize(manager, space.id, ['manage_space']);
    const b = await second.authorize(manager, space.id, ['manage_space']);
    const original = await first.invite(a, { role: 'viewer' });
    for (let index = 1; index < 49; index++) await first.invite(a, { role: 'viewer' });

    const results = await Promise.allSettled([first.invite(a, { role: 'viewer' }), second.invite(b, { role: 'viewer' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    for (const store of stores) store.close();

    const reopened = connect();
    const authority = await reopened.authorize(manager, space.id, ['manage_space']);
    expect((await reopened.invites(authority)).data).toHaveLength(50);
    await reopened.revokeInvite(authority, original.id);
    await reopened.invite(authority, { role: 'collaborator' });
    expect((await reopened.invites(authority)).data).toHaveLength(50);
    await expect(reopened.invite(authority, { role: 'viewer' })).rejects.toMatchObject({ status: 409 });
  } finally {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
