import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentResource, AgentsStore } from '../core/agents-ports.js';
import type { AgentListParams } from '../domain/agents-api.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

/** Local control-plane storage uses the same atomic revision contract as DynamoDB. */
export class SqliteAgentsStore implements AgentsStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private leaseState: 'unheld' | 'held' | 'draining' | 'closed' = 'unheld';
  private readonly retainedWork = new Set<Promise<unknown>>();

  public constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const keyPath = join(directory, 'storage.key');
    const path = join(directory, 'agents.sqlite');
    if (existsSync(path) && !existsSync(keyPath)) {
      throw new Error('The local storage key is missing. Restore storage.key with this workspace’s backup before opening it.');
    }
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('The local storage key is invalid.');
    chmodSync(keyPath, 0o600);
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS resources (
        owner TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
        created INTEGER NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY (owner, collection, id));
      CREATE INDEX IF NOT EXISTS resource_order ON resources(owner, collection, created, id);
      CREATE TABLE IF NOT EXISTS server_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL);`);
  }

  /** Only one process may dispatch local work; a dead process's lease is reclaimable. */
  public acquireServerLease(): void {
    if (this.leaseState !== 'unheld') throw new Error('This store cannot acquire another server lease.');
    this.transaction(() => {
      const previous = this.db.prepare('SELECT pid FROM server_lease WHERE singleton=1').get();
      if (previous) {
        let alive = true;
        try { process.kill(Number(previous.pid), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('This local workspace is already running. Connect to it or choose another data directory.');
      }
      this.db.prepare('INSERT OR REPLACE INTO server_lease VALUES (1, ?)').run(process.pid);
    });
    this.leaseState = 'held';
  }

  public assertServerLease(): void {
    if (!['held', 'draining'].includes(this.leaseState)
      || Number(this.db.prepare('SELECT pid FROM server_lease WHERE singleton=1').get()?.pid) !== process.pid) {
      throw new Error('The local workspace server lease is not held.');
    }
  }

  public runWhileServerLeaseHeld<T>(work: () => Promise<T>): Promise<T> {
    if (this.leaseState === 'draining') return Promise.reject(new Error('The local workspace is shutting down.'));
    try { this.assertServerLease(); } catch (error) { return Promise.reject(error); }
    const pending = Promise.resolve().then(() => { this.assertServerLease(); return work(); })
      .finally(() => { this.retainedWork.delete(pending); });
    this.retainedWork.add(pending);
    return pending;
  }

  public async drainServerLease(): Promise<void> {
    this.assertServerLease();
    this.leaseState = 'draining';
    await Promise.allSettled(this.retainedWork);
  }

  public close(releaseLease = false): void {
    if (this.leaseState === 'closed') return;
    if (this.retainedWork.size) throw new Error('Local workspace lease work is still running.');
    if (releaseLease && this.leaseState !== 'unheld') this.db.prepare('DELETE FROM server_lease WHERE pid=?').run(process.pid);
    this.db.close();
    this.key.fill(0);
    this.leaseState = 'closed';
  }

  public async get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined> {
    const row = this.db.prepare('SELECT payload FROM resources WHERE owner=? AND collection=? AND id=?').get(ownerId, collection, id);
    return row ? this.decode(row.payload as Uint8Array, ownerId, collection, id) : undefined;
  }

  public async list<T>(ownerId: string, collection: string, query: AgentListParams) {
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';
    let cursor: { createdAt: number; id: string } | undefined;
    if (query.after) {
      cursor = await this.get(ownerId, collection, query.after);
      if (!cursor) throw new AgentsApiError(400, 'Invalid pagination cursor.', 'invalid_request', 'after');
    }
    const comparison = direction === 'ASC' ? '>' : '<';
    const limit = query.limit ?? 20;
    const rows = this.db.prepare(`SELECT id, payload FROM resources WHERE owner=? AND collection=?
      ${cursor ? `AND (created, id) ${comparison} (?, ?)` : ''}
      ORDER BY created ${direction}, id ${direction} LIMIT ?`).all(
      ownerId, collection, ...(cursor ? [cursor.createdAt, cursor.id] : []), limit + 1,
    );
    return { data: rows.slice(0, limit).map(row => this.decode<T>(row.payload as Uint8Array, ownerId, collection, String(row.id))), has_more: rows.length > limit };
  }

  public put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void> {
    return this.commit([{ resource, expectedRevision }]);
  }

  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void> {
    this.transaction(() => {
      this.validateWrites(writes);
      for (const { resource } of writes) this.write(resource);
    });
  }

  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = []): Promise<void> {
    this.transaction(() => {
      this.expect(resource, resource.revision);
      this.validateWrites(writes);
      for (const { resource: next } of writes) this.write(next);
      this.db.prepare('DELETE FROM resources WHERE owner=? AND collection=? AND id=?').run(resource.ownerId, resource.collection, resource.id);
    });
  }

  private validateWrites(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>) {
    const identities = new Set<string>();
    for (const { resource, expectedRevision } of writes) {
      const key = JSON.stringify([resource.ownerId, resource.collection, resource.id]);
      if (identities.has(key) || resource.revision !== expectedRevision + 1) throw new Error('Invalid local transaction.');
      identities.add(key);
      this.expect(resource, expectedRevision);
    }
  }

  private expect(resource: AgentResource<unknown>, revision: number) {
    const current = this.db.prepare('SELECT revision FROM resources WHERE owner=? AND collection=? AND id=?').get(resource.ownerId, resource.collection, resource.id);
    if (Number(current?.revision ?? 0) !== revision) throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
  }

  private write(resource: AgentResource<unknown>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([resource.ownerId, resource.collection, resource.id])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final()]);
    this.db.prepare('INSERT OR REPLACE INTO resources VALUES (?, ?, ?, ?, ?, ?)').run(
      resource.ownerId, resource.collection, resource.id, resource.createdAt, resource.revision,
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
    );
  }

  private decode<T>(data: Uint8Array, owner: string, collection: string, id: string): AgentResource<T> {
    const bytes = Buffer.from(data);
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([owner, collection, id])));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }

  private transaction(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
