import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamConnectionStore } from '../../src/client-connections.js';
import { ConsoleTeams, parseInviteLink } from '../../src/console-team.js';
import type { LoginProvider, LoginResult } from '../../src/client-oidc.js';

const provider: LoginProvider = { id: 'team', issuer: 'https://identity.example', client_id: 'desktop', jwks_uri: 'https://identity.example/keys', profile: 'jwt_access', authorization_endpoint: 'https://identity.example/authorize', token_endpoint: 'https://identity.example/token', redirect_uri: 'http://127.0.0.1:43281/callback', scopes: ['openid'] };
const token = `rti_${'a'.repeat(43)}`;
const link = `https://api.example/v1/rat/invites#${token}`;
const login: LoginResult = { identity: { issuer: provider.issuer, subject: 'sam' }, tokens: { access_token: 'access', expires_at: Date.now() / 1000 + 300 } };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(redeem: (request: Request) => Response, providers = [provider]) {
  const directory = await mkdtemp(join(tmpdir(), 'rat-invite-')); directories.push(directory);
  const redemptions: Request[] = [];
  let discoveries = 0;
  let loginStarts = 0;
  const store = new TeamConnectionStore(directory, async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith('/rat/invites/redeem')) { redemptions.push(request.clone()); return redeem(request); }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    return Response.json({ actor: { issuer: provider.issuer, subject: token === 'access' ? 'sam' : token } });
  });
  let finish!: (result: LoginResult) => void;
  const result = new Promise<LoginResult>(resolve => { finish = resolve; });
  const teams = new ConsoleTeams(store, {
    discover: async () => { discoveries++; return { base_url: 'https://api.example/v1', login_providers: providers }; },
    begin: async () => { loginStarts++; return { url: 'https://identity.example/authorize?state=s', result, close: () => undefined }; },
  });
  return { store, teams, redemptions, finish, get discoveries() { return discoveries; }, get loginStarts() { return loginStarts; } };
}
const joined = () => Response.json({ space: { id: 'space_a', name: 'Design review' }, role: 'collaborator', joined: true });
const connectionLogin = (subject: string): LoginResult => ({
  identity: { issuer: provider.issuer, subject },
  tokens: { access_token: subject, expires_at: Date.now() / 1000 + 300 },
});

it('parses only HTTPS invite links whose secret stays in the fragment', () => {
  expect(parseInviteLink(` ${link} `)).toEqual({ endpoint: 'https://api.example/v1', token });
  for (const bad of [`http://api.example/v1/rat/invites#${token}`, `https://api.example/v1/rat/invites?token=${token}`, `https://api.example/v1/rat/invites?x=1#${token}`,
    `https://api.example/v1/rat/spaces#${token}`, 'https://api.example/v1/rat/invites#rti_short', `https://user@api.example/v1/rat/invites#${token}`, 'not a link']) {
    expect(() => parseInviteLink(bad), bad).toThrow('invite link');
  }
});

it('redeems through an existing connection to the invite endpoint', async () => {
  const s = await fixture(joined);
  const connection = await s.store.save('https://api.example/v1', provider, login);
  expect(await s.teams.route('POST', '/join', { invite: link })).toEqual({ status: 'joined', connection_id: connection.id, space: { id: 'space_a', name: 'Design review' }, role: 'collaborator', joined: true });
  expect(s.redemptions).toHaveLength(1);
  expect(s.redemptions[0]!.headers.get('authorization')).toBe('Bearer access');
  expect(s.redemptions[0]!.headers.has('x-rat-space')).toBe(false);
  expect(await s.redemptions[0]!.json()).toEqual({ token });
});

it('asks before redeeming when several verified accounts match the invite endpoint', async () => {
  const s = await fixture(joined);
  const work = await s.store.save('https://api.example/v1', provider, connectionLogin('work-account'));
  const personal = await s.store.save('https://api.example/v1', provider, connectionLogin('personal-account'));

  const result = await s.teams.route('POST', '/join', { invite: link });

  expect(result).toMatchObject({
    status: 'choose_connection',
    endpoint: 'https://api.example/v1',
    connections: expect.arrayContaining([
      { id: work.id, identity: { issuer: provider.issuer, subject: 'work-account' }, provider: { id: 'team' } },
      { id: personal.id, identity: { issuer: provider.issuer, subject: 'personal-account' }, provider: { id: 'team' } },
    ]),
  });
  expect(JSON.stringify(result)).not.toContain('tokens');
  expect(s.redemptions).toHaveLength(0);
  expect(s.discoveries).toBe(0);
  expect(s.loginStarts).toBe(0);
});

it('redeems with the explicitly selected verified account', async () => {
  const s = await fixture(joined);
  await s.store.save('https://api.example/v1', provider, connectionLogin('work-account'));
  const personal = await s.store.save('https://api.example/v1', provider, connectionLogin('personal-account'));

  const result = await s.teams.route('POST', '/join', { invite: link, connection_id: personal.id });

  expect(result).toMatchObject({ status: 'joined', connection_id: personal.id });
  expect(s.redemptions).toHaveLength(1);
  expect(s.redemptions[0]!.headers.get('authorization')).toBe('Bearer personal-account');
  expect(s.discoveries).toBe(0);
  expect(s.loginStarts).toBe(0);
});

it('rejects a deleted account selection without redeeming or starting a new sign-in', async () => {
  const s = await fixture(joined);
  const removed = await s.store.save('https://api.example/v1', provider, connectionLogin('work-account'));
  await s.store.remove(removed.id);

  expect(await s.teams.route('POST', '/join', { invite: link, connection_id: removed.id })).toMatchObject({ status: 'failed' });
  expect(s.redemptions).toHaveLength(0);
  expect(s.discoveries).toBe(0);
  expect(s.loginStarts).toBe(0);
});

it('rejects an account selection from a different team endpoint', async () => {
  const s = await fixture(joined);
  const other = await s.store.save('https://other.example/v1', provider, connectionLogin('work-account'));

  expect(await s.teams.route('POST', '/join', { invite: link, connection_id: other.id })).toMatchObject({ status: 'failed' });
  expect(s.redemptions).toHaveLength(0);
  expect(s.discoveries).toBe(0);
  expect(s.loginStarts).toBe(0);
});

it('signs in first, then redeems, and keeps the sign-in when the invite was already used', async () => {
  const s = await fixture(joined);
  const waiting = await s.teams.route('POST', '/join', { invite: link }) as { id: string; status: string };
  expect(waiting.status).toBe('waiting');
  s.finish(login);
  await expect.poll(async () => (await s.teams.route('GET', `/login/${waiting.id}`, {}) as { status: string }).status).toBe('complete');
  expect(await s.teams.route('GET', `/login/${waiting.id}`, {})).toMatchObject({ joined: { space: { id: 'space_a' }, role: 'collaborator' } });

  const used = await fixture(() => Response.json({ error: { message: 'used' } }, { status: 404 }));
  const attempt = await used.teams.route('POST', '/join', { invite: link }) as { id: string };
  used.finish(login);
  await expect.poll(async () => (await used.teams.route('GET', `/login/${attempt.id}`, {}) as { status: string }).status).toBe('complete');
  expect(await used.teams.route('GET', `/login/${attempt.id}`, {})).toMatchObject({ invite_error: expect.stringContaining('already used') });
  expect(await used.store.list()).toHaveLength(1);
});

it('reports invalid links and used invites without starting sign-in, and asks for a provider when several exist', async () => {
  const s = await fixture(() => Response.json({}, { status: 404 }), [provider, { ...provider, id: 'other' }]);
  expect(await s.teams.route('POST', '/join', { invite: 'https://api.example/v1/rat/invites' })).toMatchObject({ status: 'failed', error: expect.stringContaining('invite link') });
  expect(await s.teams.route('POST', '/join', { invite: link })).toMatchObject({ status: 'choose_provider', endpoint: 'https://api.example/v1', login_providers: [{ id: 'team' }, { id: 'other' }] });
  expect(await s.teams.route('POST', '/login', { endpoint: 'https://api.example/v1', provider_id: 'other', invite: link })).toMatchObject({ status: 'waiting' });
  await s.store.save('https://api.example/v1', provider, login);
  expect(await s.teams.route('POST', '/join', { invite: link })).toMatchObject({ status: 'failed', error: expect.stringContaining('already used') });
  s.teams.close();
});
