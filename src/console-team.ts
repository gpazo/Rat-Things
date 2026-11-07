import { randomUUID } from 'node:crypto';
import { TeamConnectionStore, type TeamConnection } from './client-connections.js';
import { beginBrowserLogin, discoverTeamLogin, type LoginAttempt } from './client-oidc.js';

type LoginState = { id: string; status: 'waiting'; url: string } | { id: string; status: 'complete'; connection: TeamConnection } | { id: string; status: 'failed'; error: string };
export class ConsoleTeams {
  private readonly logins = new Map<string, { state: LoginState; attempt: LoginAttempt; cancelled: boolean }>();
  constructor(readonly store = new TeamConnectionStore()) {}
  async route(method: string, path: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'GET' && path === '/connections') return { data: await this.store.list() };
    if (method === 'POST' && path === '/discovery') return discoverTeamLogin(String(input.endpoint));
    if (method === 'POST' && path === '/login') {
      if ([...this.logins.values()].some(login => login.state.status === 'waiting')) throw new Error('Finish or cancel the current team sign-in first');
      const discovered = await discoverTeamLogin(String(input.endpoint));
      const provider = discovered.login_providers.find(p => p.id === input.provider_id) ?? (discovered.login_providers.length === 1 ? discovered.login_providers[0] : undefined);
      if (!provider) throw new Error('Choose a team sign-in provider');
      const reconnect = typeof input.connection_id === 'string' ? (await this.store.list()).find(c => c.id === input.connection_id) : undefined;
      if (input.connection_id && (!reconnect || reconnect.endpoint !== discovered.base_url || reconnect.provider.id !== provider.id)) throw new Error('Reconnect must use the saved team provider');
      const attempt = await beginBrowserLogin(provider);
      const id = randomUUID();
      const login = { state: { id, status: 'waiting', url: attempt.url } as LoginState, attempt, cancelled: false };
      this.logins.set(id, login);
      void attempt.result.then(async result => {
        if (login.cancelled) return;
        if (reconnect && (result.identity.issuer !== reconnect.identity.issuer || result.identity.subject !== reconnect.identity.subject)) throw new Error('Sign in with the original team identity to reconnect');
        const connection = await this.store.save(discovered.base_url, provider, result, reconnect?.id);
        if (login.cancelled) { await this.store.remove(connection.id); return; }
        login.state = { id, status: 'complete', connection };
      }).catch(() => { if (login.cancelled) return; login.state = { id, status: 'failed', error: 'Team sign-in did not complete. Try again with your team account.' }; });
      return login.state;
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
      if (method === 'POST' && match[2] === 'logout') { await this.store.remove(connection.id); return { status: 'signed_out' }; }
      if (method === 'GET' && match[2] === 'spaces') {
        const client = await this.store.client({ connection_id: connection.id, endpoint: connection.endpoint });
        const response = await client.fetch(`${client.baseURL}/rat/spaces`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('Your team connection needs sign-in again');
        return response.json();
      }
    }
    throw new Error('Unknown team connection route');
  }
  close(): void { for (const login of this.logins.values()) if (login.state.status === 'waiting') { login.cancelled = true; login.attempt.close(); } }
}
