import { randomUUID } from 'node:crypto';
import { TeamConnectionStore, type TeamConnection } from './client-connections.js';
import { beginBrowserLogin, discoverTeamLogin, type LoginAttempt } from './client-oidc.js';

type Joined = { space: { id: string; name: string }; role: string; joined: boolean };
type LoginState = { id: string; status: 'waiting'; url: string } | { id: string; status: 'complete'; connection: TeamConnection; joined?: Joined; invite_error?: string } | { id: string; status: 'failed'; error: string };
type InviteConnectionOption = Pick<TeamConnection, 'id' | 'identity'> & { provider: Pick<TeamConnection['provider'], 'id'> };
type InviteJoinPlan =
  | { kind: 'redeem'; connection: TeamConnection }
  | { kind: 'choose_connection'; connections: TeamConnection[] }
  | { kind: 'sign_in' }
  | { kind: 'failed'; error: string };
const INVITE_PATH = '/v1/rat/invites';
const INVITE_TOKEN = /^rti_[A-Za-z0-9_-]{43}$/;

function planInviteJoin(endpoint: string, connections: TeamConnection[], selectedId?: string): InviteJoinPlan {
  if (selectedId !== undefined) {
    const selected = connections.find(connection => connection.id === selectedId);
    if (!selected) return { kind: 'failed', error: 'The selected team account is no longer available. Choose again.' };
    if (selected.endpoint !== endpoint) return { kind: 'failed', error: 'The selected team account belongs to another team endpoint.' };
    return { kind: 'redeem', connection: selected };
  }
  const matching = connections.filter(connection => connection.endpoint === endpoint);
  if (matching.length === 1) return { kind: 'redeem', connection: matching[0]! };
  if (matching.length > 1) return { kind: 'choose_connection', connections: matching };
  return { kind: 'sign_in' };
}

function inviteConnectionOption(connection: TeamConnection): InviteConnectionOption {
  return { id: connection.id, identity: connection.identity, provider: { id: connection.provider.id } };
}

/** An invite link is the team endpoint plus a fragment secret, so opening it in a browser never sends the secret. */
export function parseInviteLink(value: unknown): { endpoint: string; token: string } {
  let url: URL;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Paste the complete invite link'); }
  const token = url.hash.slice(1);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.pathname !== INVITE_PATH || !INVITE_TOKEN.test(token)) throw new Error('Paste the complete invite link');
  return { endpoint: `${url.origin}/v1`, token };
}

export class ConsoleTeams {
  private readonly logins = new Map<string, { state: LoginState; attempt: LoginAttempt; cancelled: boolean; connectionId: string | undefined }>();
  constructor(readonly store = new TeamConnectionStore(), private readonly authentication = { discover: discoverTeamLogin, begin: beginBrowserLogin }) {}
  async route(method: string, path: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'GET' && path === '/connections') return { data: await this.store.list() };
    if (method === 'POST' && path === '/discovery') return this.authentication.discover(String(input.endpoint));
    if (method === 'POST' && path === '/login') {
      const invite = input.invite === undefined || input.invite === '' ? undefined : parseInviteLink(input.invite);
      return this.login(String(input.endpoint), input.provider_id, input.connection_id, invite);
    }
    if (method === 'POST' && path === '/join') {
      let invite: { endpoint: string; token: string };
      try { invite = parseInviteLink(input.invite); } catch (error) { return { status: 'failed', error: (error as Error).message }; }
      const selectedId = typeof input.connection_id === 'string' ? input.connection_id : undefined;
      if (Object.hasOwn(input, 'connection_id') && selectedId === undefined) {
        return { status: 'failed', error: 'The selected team account is no longer available. Choose again.' };
      }
      const plan = planInviteJoin(invite.endpoint, await this.store.list(), selectedId);
      if (plan.kind === 'failed') return { status: 'failed', error: plan.error };
      if (plan.kind === 'choose_connection') {
        return { status: 'choose_connection', endpoint: invite.endpoint, connections: plan.connections.map(inviteConnectionOption) };
      }
      if (plan.kind === 'redeem') {
        try { return { status: 'joined', connection_id: plan.connection.id, ...await this.redeem(plan.connection, invite.token) }; }
        catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : 'The invite could not be used.' }; }
      }
      const discovered = await this.authentication.discover(invite.endpoint);
      if (discovered.login_providers.length > 1 && !discovered.login_providers.some(p => p.id === input.provider_id)) {
        return { status: 'choose_provider', endpoint: discovered.base_url, login_providers: discovered.login_providers };
      }
      return this.login(invite.endpoint, input.provider_id, undefined, invite);
    }
    const loginMatch = /^\/login\/([a-f0-9-]{36})$/.exec(path);
    if (loginMatch) {
      const login = this.logins.get(loginMatch[1]!);
      if (!login) throw new Error('Team sign-in was not found');
      if (method === 'DELETE') { login.cancelled = true; login.attempt.close(); this.logins.delete(loginMatch[1]!); return { status: 'cancelled' }; }
      if (method === 'GET') return login.state;
    }
    const match = /^\/connections\/([a-f0-9-]{36})\/(spaces|logout)$/.exec(path);
    if (match) {
      const connection = (await this.store.list()).find(c => c.id === match[1]);
      if (!connection) throw new Error('Team connection was not found');
      if (method === 'POST' && match[2] === 'logout') {
        for (const login of this.logins.values()) if (login.connectionId === connection.id && login.state.status === 'waiting') {
          login.cancelled = true;
          login.attempt.close();
          login.state = { id: login.state.id, status: 'failed', error: 'This connection was signed out. Start a new sign-in.' };
        }
        await this.store.remove(connection.id);
        return { status: 'signed_out' };
      }
      if (method === 'GET' && match[2] === 'spaces') {
        const client = await this.store.client({ connection_id: connection.id, endpoint: connection.endpoint });
        const response = await client.fetch(`${client.baseURL}/rat/spaces`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('Your team connection needs sign-in again');
        return response.json();
      }
    }
    throw new Error('Unknown team connection route');
  }
  private async login(endpoint: string, providerId: unknown, connectionId: unknown, invite?: { endpoint: string; token: string }): Promise<LoginState> {
    if ([...this.logins.values()].some(login => login.state.status === 'waiting')) throw new Error('Finish or cancel the current team sign-in first');
    const discovered = await this.authentication.discover(endpoint);
    if (invite && invite.endpoint !== discovered.base_url) throw new Error('This invite belongs to another team endpoint');
    const provider = discovered.login_providers.find(p => p.id === providerId) ?? (discovered.login_providers.length === 1 ? discovered.login_providers[0] : undefined);
    if (!provider) throw new Error('Choose a team sign-in provider');
    const reconnect = typeof connectionId === 'string' ? (await this.store.list()).find(c => c.id === connectionId) : undefined;
    if (connectionId && (!reconnect || reconnect.endpoint !== discovered.base_url || reconnect.provider.id !== provider.id)) throw new Error('Reconnect must use the saved team provider');
    const attempt = await this.authentication.begin(provider);
    if (reconnect && !(await this.store.list()).some(connection => connection.id === reconnect.id)) {
      attempt.close();
      throw new Error('This team connection was signed out');
    }
    const id = randomUUID();
    const login = { state: { id, status: 'waiting', url: attempt.url } as LoginState, attempt, cancelled: false, connectionId: reconnect?.id };
    this.logins.set(id, login);
    void attempt.result.then(async result => {
      if (login.cancelled) return;
      if (reconnect && (result.identity.issuer !== reconnect.identity.issuer || result.identity.subject !== reconnect.identity.subject)) throw new Error('Sign in with the original team identity to reconnect');
      const connection = await this.store.save(discovered.base_url, provider, result, reconnect?.id);
      if (login.cancelled) { await this.store.remove(connection.id); return; }
      if (!invite) { login.state = { id, status: 'complete', connection }; return; }
      // Sign-in succeeded even if the invite was already used; keep the connection and report the invite separately.
      const redeemed = await this.redeem(connection, invite.token).then(joined => ({ joined }), (error: unknown) => ({ invite_error: error instanceof Error ? error.message : 'The invite could not be used.' }));
      if (!login.cancelled) login.state = { id, status: 'complete', connection, ...redeemed };
    }).catch(() => { if (login.cancelled) return; login.state = { id, status: 'failed', error: 'Team sign-in did not complete. Try again with your team account.' }; });
    return login.state;
  }
  private async redeem(connection: TeamConnection, token: string): Promise<Joined> {
    const client = await this.store.client({ connection_id: connection.id, endpoint: connection.endpoint });
    const response = await client.fetch(`${client.baseURL}/rat/invites/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) throw new Error('This invite link is invalid, expired or already used. Ask for a new one.');
    if (!response.ok) throw new Error('This team sign-in could not use the invite.');
    const value = await response.json() as Partial<Joined>;
    if (typeof value.space?.id !== 'string' || typeof value.space.name !== 'string' || typeof value.role !== 'string') throw new Error('The team returned an invalid invite response.');
    return { space: { id: value.space.id, name: value.space.name }, role: value.role, joined: value.joined === true };
  }
  close(): void { for (const login of this.logins.values()) if (login.state.status === 'waiting') { login.cancelled = true; login.attempt.close(); } }
}
