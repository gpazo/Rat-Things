import { mkdir, lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentsFetch } from './agents-client.js';
import { parseLoginProvider, refreshLogin, type LoginProvider, type LoginResult, type LoginTokens, type LoginIdentity } from './client-oidc.js';

export class TeamSignInRequired extends Error { constructor() { super("Team sign-in expired. Reconnect to continue."); this.name = "TeamSignInRequired"; } }
export interface TeamConnection { id: string; endpoint: string; provider: LoginProvider; identity: LoginIdentity; }
interface StoredConnection extends TeamConnection { tokens: LoginTokens; }
const defaultDirectory = () => process.env.RAT_THINGS_CONNECTIONS_DIR ?? join(homedir(), '.rat-things', 'connections');
export class TeamConnectionStore {
  constructor(private readonly directory = defaultDirectory(), private readonly transport: typeof fetch = fetch) {}
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Team credential storage must be a private directory owned by this user');
  }
  private path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid team connection'); return join(this.directory, `${id}.json`); }
  private async read(id: string): Promise<StoredConnection> {
    await this.prepare();
    const file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 256_000) throw new Error('Team credentials are not stored privately');
      const value = JSON.parse(await file.readFile('utf8')) as StoredConnection;
      if (value.id !== id || new URL(value.endpoint).protocol !== 'https:' || !value.identity?.subject || !value.tokens?.access_token || typeof value.tokens.expires_at !== 'number') throw new Error('Invalid team connection');
      value.provider = parseLoginProvider(value.provider);
      return value;
    } finally { await file.close(); }
  }
  private async write(value: StoredConnection): Promise<void> {
    await this.prepare();
    const destination = this.path(value.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
  }
  async save(endpoint: string, provider: LoginProvider, login: LoginResult, id: string = randomUUID()): Promise<TeamConnection> {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') throw new Error('Invalid team endpoint');
    const value = { id, endpoint: `${url.origin}/v1`, provider, ...login };
    await this.verify(value);
    await this.locked(id, () => this.write(value));
    return publicConnection(value);
  }
  async list(): Promise<TeamConnection[]> {
    await this.prepare();
    const connections: TeamConnection[] = [];
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) connections.push(publicConnection(await this.read(file.slice(0, -5))));
    return connections;
  }
  async remove(id: string): Promise<void> { await this.locked(id, () => rm(this.path(id), { force: true })); }
  private async verify(value: StoredConnection): Promise<void> {
    const api = createAgentsFetch({ baseURL: value.endpoint, accessToken: async () => value.tokens.access_token, fetch: this.transport });
    const response = await api(`${value.endpoint}/rat/me`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('This sign-in cannot access the team API');
    const me = await response.json() as { actor?: { issuer?: string; subject?: string } };
    if (me.actor?.issuer !== value.identity.issuer || me.actor?.subject !== value.identity.subject) throw new Error('The team API identity did not match sign-in');
  }
  async accessToken(id: string): Promise<string> {
    try { return await this.resolveAccessToken(id); } catch { throw new TeamSignInRequired(); }
  }
  private async resolveAccessToken(id: string): Promise<string> {
    let value = await this.read(id);
    if (value.tokens.expires_at > Date.now() / 1000 + 60) return value.tokens.access_token;
    return this.locked(id, async () => {
      value = await this.read(id);
      if (value.tokens.expires_at > Date.now() / 1000 + 60) return value.tokens.access_token;
      value.tokens = await refreshLogin(value.provider, value.tokens, this.transport);
      await this.verify(value);
      await this.write(value);
      return value.tokens.access_token;
    });
  }
  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this.prepare();
    const lock = `${this.path(id)}.lock`;
    let acquired = false;
    for (let i = 0; i < 150; i++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(lock).catch(() => undefined);
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('Invalid team credential lock');
      const owner = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => ''));
      let abandoned = !owner && Date.now() - info.mtimeMs > 60_000;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (abandoned) {
        const reclaim = `${lock}.reclaim`;
        let reclaiming = false;
        try {
          await mkdir(reclaim, { mode: 0o700 }); reclaiming = true;
          const current = await lstat(lock).catch(() => undefined);
          const pid = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => ''));
          let dead = current !== undefined && !pid && Date.now() - current.mtimeMs > 60_000;
          if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
          if (dead) await rm(lock, { recursive: true, force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        finally { if (reclaiming) await rm(reclaim, { recursive: true, force: true }); }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!acquired) throw new Error('Team sign-in is busy. Try again shortly.');
    try {
      const owner = await open(join(lock, 'pid'), 'wx', 0o600);
      try { await owner.writeFile(String(process.pid)); } finally { await owner.close(); }
      return await operation();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async client(input: { connection_id: string; endpoint: string; space_id?: string }): Promise<{ fetch: typeof fetch; baseURL: string; connection: TeamConnection }> {
    const value = await this.read(input.connection_id);
    if (input.endpoint.replace(/\/$/, '') !== value.endpoint) throw new Error('This connection belongs to another team endpoint');
    return { baseURL: value.endpoint, connection: publicConnection(value), fetch: createAgentsFetch({ baseURL: value.endpoint,
      accessToken: () => this.accessToken(value.id), ...(input.space_id ? { spaceId: input.space_id } : {}), fetch: this.transport }) };
  }
}
function publicConnection(value: StoredConnection): TeamConnection { return { id: value.id, endpoint: value.endpoint, provider: value.provider, identity: value.identity }; }
export async function createTeamConnectionClient(input: { connection_id: string; endpoint: string; space_id: string }): Promise<{ fetch: typeof fetch; baseURL: string }> {
  return new TeamConnectionStore().client(input);
}
