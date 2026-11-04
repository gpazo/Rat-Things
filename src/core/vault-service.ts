import { commitConfiguration, configurationConflict, configurationRef, missingConfigurationBaseline, planConfigurationRevision, type ConfigurationWrite } from './configuration-history.js';
import type { ConfigurationMutation, ConfigurationSnapshot, ConfigurationSubject } from '../domain/configuration-history.js';
import type { McpAuthorization } from '../domain/tool-authorization.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { needsOAuthRefresh, planOAuthRefresh, refreshedOAuthCredential, type OAuthRefreshClient } from '../domain/vault-oauth.js';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import type { Credential, CredentialDeleted, Vault, VaultDeleted } from '../domain/agents-api.js';
import type { AgentCredentialSecrets } from '../credentials/agents-vault.js';
import { AgentsApiError, parseAgentsContract, resourceNotFound, validateAgentMetadata } from '../domain/agents-api-validation.js';
import { credentialUrl, publicCredentialAuth, rotateCredentialAuth, validateCredentialAuth, vaultName } from '../domain/vault-planning.js';
import type { AgentResource, AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';
import { cursorPage } from './session-planning.js';
import { validateEnvironmentCredentialPolicy, type EnvironmentCredentialAuth, type HostedCredentialPolicy } from '../domain/environment-credential-planning.js';
import { canonicalJson } from '../domain/json.js';

interface StoredVault { vault: Vault; status: 'active' | 'archived' }
interface StoredCredential { credential: Credential; status: 'active' | 'archived'; secret: string; refreshLease?: { id: string; expiresAt: number }; pendingRefresh?: { credential: Credential; secret: string } }

export class VaultService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;

  public constructor(private readonly options: { store: AgentsStore; secrets: AgentCredentialSecrets; oauth?: OAuthRefreshClient; clock?: AgentsClock; ids?: AgentsIds }) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }

  public async create(ownerId: string, raw: unknown = {}, mutation: ConfigurationMutation = {}): Promise<Vault> {
    const input = parseAgentsContract('VaultCreate', raw);
    validateAgentMetadata(input.metadata);
    const vault: Vault = { id: this.ids.next('vault'), object: 'vault', created_at: this.clock.now(), name: input.name === undefined ? null : vaultName(input.name), metadata: input.metadata ?? {} };
    await this.commit([{ resource: { id: vault.id, ownerId, collection: 'vaults', createdAt: vault.created_at, revision: 1, value: { vault, status: 'active' } }, expectedRevision: 0 }], mutation);
    return vault;
  }

  public async retrieve(ownerId: string, id: string): Promise<Vault> { return (await this.vault(ownerId, id)).value.vault; }

  public async list(ownerId: string, raw: unknown = {}) {
    const query = parseAgentsContract('VaultList', raw);
    const resources = await this.all<StoredVault>(ownerId, 'vaults');
    const statuses = query.status === undefined ? ['active', 'archived'] : [query.status].flat();
    return cursorPage(resources.filter(({ value }) => statuses.includes(value.status)).map(({ value }) => value.vault), query);
  }

  public async delete(ownerId: string, id: string, mutation: ConfigurationMutation = {}): Promise<VaultDeleted> {
    let resource = await this.vault(ownerId, id);
    if (resource.value.status !== 'archived') {
      resource = await this.replace(resource, { ...resource.value, status: 'archived' }, mutation);
    }
    // Archiving the parent first closes the creation/rotation fence. Retrying resumes cleanup.
    for (const credential of await this.all<StoredCredential>(ownerId, `vaults/${id}/credentials`)) {
      await this.archiveCredential(credential, mutation);
    }
    return { id, object: 'vault.deleted', deleted: true };
  }

  public async createCredential(ownerId: string, vaultId: string, raw: unknown, mutation: ConfigurationMutation = {}): Promise<Credential> {
    const input = parseAgentsContract('CredentialCreate', raw);
    const name = vaultName(input.name);
    validateCredentialAuth(input.auth);
    const parent = await this.activeVault(ownerId, vaultId);
    const id = this.ids.next('cred');
    const now = this.clock.now();
    const credential: Credential = { id, object: 'vault.credential', vault_id: vaultId, name, auth: publicCredentialAuth(input.auth), created_at: now, updated_at: now };
    const secret = await this.options.secrets.create(ownerId, id, input.auth);
    try {
      await this.commit([
        { resource: { ...parent, revision: parent.revision + 1 }, expectedRevision: parent.revision },
        { resource: { id, ownerId, collection: `vaults/${vaultId}/credentials`, createdAt: now, revision: 1, value: { credential, secret, status: 'active' } }, expectedRevision: 0 },
      ], mutation);
    } catch (error) {
      // An ambiguous storage failure may have committed. Never revoke its live secret.
      if (error instanceof AgentsApiError && error.status === 409) await this.options.secrets.revoke(secret);
      throw error;
    }
    return credential;
  }

  public async credential(ownerId: string, vaultId: string, id: string): Promise<Credential> {
    await this.vault(ownerId, vaultId);
    return (await this.storedCredential(ownerId, vaultId, id)).value.credential;
  }

  public async credentials(ownerId: string, vaultId: string, raw: unknown = {}) {
    const query = parseAgentsContract('CredentialList', raw);
    await this.vault(ownerId, vaultId);
    const resources = await this.all<StoredCredential>(ownerId, `vaults/${vaultId}/credentials`);
    const statuses = query.status === undefined ? ['active', 'archived'] : [query.status].flat();
    return cursorPage(resources.filter(({ value }) => statuses.includes(value.status)).map(({ value }) => value.credential), query);
  }

  public async updateCredential(ownerId: string, vaultId: string, id: string, raw: unknown, mutation: ConfigurationMutation = {}): Promise<Credential> {
    const { auth: update } = parseAgentsContract('CredentialUpdate', raw);
    const parent = await this.activeVault(ownerId, vaultId);
    const previous = await this.storedCredential(ownerId, vaultId, id);
    if (previous.value.status !== 'active') resourceNotFound();
    const auth = rotateCredentialAuth(await this.options.secrets.read(previous.value.pendingRefresh?.secret ?? previous.value.secret), update);
    validateCredentialAuth(auth);
    const secret = await this.options.secrets.create(ownerId, id, auth);
    const credential = { ...previous.value.credential, auth: publicCredentialAuth(auth), updated_at: this.clock.now() };
    try {
      await this.commit([
        { resource: { ...parent, revision: parent.revision + 1 }, expectedRevision: parent.revision },
        { resource: { ...previous, revision: previous.revision + 1, value: { status: previous.value.status, credential, secret } }, expectedRevision: previous.revision },
      ], mutation);
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 409) await this.options.secrets.revoke(secret);
      throw error;
    }
    await this.options.secrets.revoke(previous.value.secret);
    if (previous.value.pendingRefresh) await this.options.secrets.revoke(previous.value.pendingRefresh.secret);
    return credential;
  }

  public async deleteCredential(ownerId: string, vaultId: string, id: string, mutation: ConfigurationMutation = {}): Promise<CredentialDeleted> {
    await this.vault(ownerId, vaultId);
    await this.archiveCredential(await this.storedCredential(ownerId, vaultId, id), mutation);
    return { id, object: 'vault.credential.deleted', deleted: true };
  }

  /** Resolve only from explicitly attached, owned vaults and an exact normalized destination. */
  public resolve(ownerId: string, vaultIds: string[], serverUrl: string, credentialId?: string | null, allowMissing?: false): Promise<{ credential: Credential; reference: string }>;
  public resolve(ownerId: string, vaultIds: string[], serverUrl: string, credentialId: string | null | undefined, allowMissing: true): Promise<{ credential: Credential; reference: string } | undefined>;
  public async resolve(ownerId: string, vaultIds: string[], serverUrl: string, credentialId?: string | null, allowMissing = false) {
    const matches: StoredCredential[] = [];
    for (const vaultId of [...new Set(vaultIds)]) {
      await this.activeVault(ownerId, vaultId);
      for (const { value } of await this.all<StoredCredential>(ownerId, `vaults/${vaultId}/credentials`)) {
        if (value.status === 'active' && value.credential.auth.type !== 'environment_variable' && credentialUrl(value.credential.auth.mcp_server_url) === credentialUrl(serverUrl) && (!credentialId || value.credential.id === credentialId)) matches.push(value);
      }
    }
    if (!matches.length && allowMissing && !credentialId) return undefined;
    if (matches.length !== 1) throw new AgentsApiError(400, matches.length ? 'Several credentials match this MCP destination; specify credential_id.' : 'No attached credential matches this MCP destination.', 'invalid_credential', 'agent.tools.credential_id');
    return { credential: matches[0]!.credential, reference: matches[0]!.secret };
  }

  public async requireVaults(ownerId: string, ids: string[]): Promise<void> { for (const id of [...new Set(ids)]) await this.activeVault(ownerId, id); }

  /** Snapshot an admitted grant for one hosted Session; later rotations affect new Sessions. */
  public async environmentSnapshot(ownerId: string, ids: string[], policy: HostedCredentialPolicy): Promise<EnvironmentCredentialAuth[]> {
    const selected: StoredCredential[] = [];
    for (const id of [...new Set(ids)]) {
      await this.activeVault(ownerId, id);
      selected.push(...(await this.all<StoredCredential>(ownerId, `vaults/${id}/credentials`)).map(resource => resource.value)
        .filter(value => value.status === 'active' && value.credential.auth.type === 'environment_variable'));
    }
    validateEnvironmentCredentialPolicy(selected.flatMap(value => value.credential.auth.type === 'environment_variable' ? [value.credential.auth] : []), policy);
    return Promise.all(selected.map(async value => {
      const auth = await this.options.secrets.read(value.secret);
      if (auth.type !== 'environment_variable') throw new Error('Environment credential type changed');
      validateCredentialAuth(auth);
      if (canonicalJson(publicCredentialAuth(auth)) !== canonicalJson(value.credential.auth)) throw new Error('Environment credential destination changed');
      return auth;
    }));
  }

  /** Only the trusted MCP transport reads bearer values. Refreshes have a durable per-credential lease. */
  public async authorization(ownerId: string, vaultId: string, id: string, serverUrl: string, rejectedToken?: string): Promise<string> {
    return (await this.authorizeMcp(ownerId, vaultId, id, serverUrl, rejectedToken)).authorization;
  }

  public async authorizeMcp(ownerId: string, vaultId: string, id: string, serverUrl: string, rejectedToken?: string): Promise<McpAuthorization> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const observedParent = await this.activeVault(ownerId, vaultId);
      const resource = await this.storedCredential(ownerId, vaultId, id);
      if (resource.value.status !== 'active' || resource.value.credential.auth.type === 'environment_variable' || credentialUrl(resource.value.credential.auth.mcp_server_url) !== credentialUrl(serverUrl)) resourceNotFound();
      const auth = await this.options.secrets.read(resource.value.pendingRefresh?.secret ?? resource.value.secret);
      const token = bearer(auth);
      const refresh = auth.type === 'mcp_oauth' && (resource.value.pendingRefresh || needsOAuthRefresh(auth, this.clock.now()) || rejectedToken === token);
      if (!refresh) {
        // Never attach a newer policy revision to a token read from an older secret.
        if (canonicalJson(publicCredentialAuth(auth)) !== canonicalJson(resource.value.credential.auth)) resourceNotFound();
        try {
          const evidence = await this.checkedEvidence(observedParent, resource, serverUrl);
          if (evidence) return { authorization: token, evidence };
        } catch (error) { if (!configurationConflict(error)) throw error; }
        continue;
      }
      if (!this.options.oauth) throw new AgentsApiError(503, 'MCP OAuth refresh is unavailable.', 'credential_refresh_failed');
      const request = planOAuthRefresh(auth);
      if ((resource.value.refreshLease?.expiresAt ?? 0) > this.clock.now()) { await delay(200); continue; }
      const lease = { id: this.ids.next('refresh'), expiresAt: this.clock.now() + 60 };
      let locked: AgentResource<StoredCredential>;
      try { locked = await this.replace(resource, { ...resource.value, refreshLease: lease }); }
      catch (error) { if (error instanceof AgentsApiError && error.status === 409) continue; throw error; }
      let replacement: string | undefined;
      let committed = false;
      try {
        const refreshed = locked.value.pendingRefresh ? auth : refreshedOAuthCredential(auth, await this.options.oauth.refresh(request), this.clock.now());
        replacement = locked.value.pendingRefresh?.secret ?? await this.options.secrets.create(ownerId, id, refreshed);
        const credential = locked.value.pendingRefresh?.credential ?? { ...resource.value.credential, auth: publicCredentialAuth(refreshed), updated_at: this.clock.now() };
        // Persist the rotated grant before retrying the parent fence. A later invocation
        // can finish this commit without reusing a refresh token already consumed upstream.
        if (!locked.value.pendingRefresh) locked = await this.replace(locked, { ...locked.value, pendingRefresh: { secret: replacement, credential } });
        // A change to another credential may update the parent while the token endpoint runs.
        // Retry that fence with the same refreshed grant; never exchange it a second time.
        for (let writeAttempt = 0; ; writeAttempt++) {
          const parent = await this.activeVault(ownerId, vaultId);
          try {
            await this.commit([
              { resource: { ...parent, revision: parent.revision + 1 }, expectedRevision: parent.revision },
              { resource: { ...locked, revision: locked.revision + 1, value: { credential, secret: replacement, status: 'active' } }, expectedRevision: locked.revision },
            ]);
            break;
          } catch (error) {
            if (!(error instanceof AgentsApiError) || error.status !== 409 || writeAttempt >= 10 || (await this.storedCredential(ownerId, vaultId, id)).revision !== locked.revision) throw error;
          }
        }
        committed = true;
        await this.options.secrets.revoke(resource.value.secret);
        rejectedToken = undefined;
        continue;
      } catch (error) {
        if (!committed && error instanceof AgentsApiError && error.status === 409) {
          const latest = await this.storedCredential(ownerId, vaultId, id);
          if (replacement && latest.value.pendingRefresh?.secret === replacement && latest.value.status === 'active') throw new AgentsApiError(503, 'The refreshed credential is awaiting a storage commit. Retry shortly.', 'credential_refresh_in_progress');
          if (replacement) await this.options.secrets.revoke(replacement);
          continue;
        }
        if (!committed && replacement && error instanceof AgentsApiError && error.status === 404) await this.options.secrets.revoke(replacement);
        // An ambiguous write may have committed. Never revoke the replacement on uncertainty.
        throw error;
      } finally {
        const current = await this.storedCredential(ownerId, vaultId, id);
        if (current.value.refreshLease?.id === lease.id) {
          const { refreshLease: _lease, ...value } = current.value;
          try { await this.replace(current, value); }
          catch (error) { if (!(error instanceof AgentsApiError) || error.status !== 409) throw error; }
        }
      }
    }
    throw new AgentsApiError(503, 'The MCP credential is being refreshed. Retry shortly.', 'credential_refresh_in_progress');
  }

  private async archiveCredential(resource: AgentResource<StoredCredential>, mutation: ConfigurationMutation) {
    const archived = resource.value.status === 'archived' ? resource : await this.replace(resource, { ...resource.value, status: 'archived' }, mutation);
    await this.options.secrets.revoke(archived.value.secret);
    if (archived.value.pendingRefresh) await this.options.secrets.revoke(archived.value.pendingRefresh.secret);
  }

  private async vault(ownerId: string, id: string) { return await this.options.store.get<StoredVault>(ownerId, 'vaults', id) ?? resourceNotFound(); }
  private async activeVault(ownerId: string, id: string) {
    const resource = await this.vault(ownerId, id);
    return resource.value.status === 'active' ? resource : resourceNotFound();
  }
  private async storedCredential(ownerId: string, vaultId: string, id: string) { return await this.options.store.get<StoredCredential>(ownerId, `vaults/${vaultId}/credentials`, id) ?? resourceNotFound(); }

  private async all<T>(ownerId: string, collection: string): Promise<AgentResource<T>[]> {
    const result: AgentResource<T>[] = [];
    let after: string | undefined;
    do {
      const page = await this.options.store.list<T>(ownerId, collection, { order: 'asc', limit: 100, ...(after ? { after } : {}) });
      result.push(...page.data);
      if (!page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    return result;
  }

  private async checkedEvidence(parent: AgentResource<StoredVault>, credential: AgentResource<StoredCredential>, serverUrl: string): Promise<Extract<McpAuthorization['evidence'], { kind: 'vault' }> | undefined> {
    const now = this.clock.now();
    const sources = [parent, credential];
    const baselines = (await Promise.all(sources.map(resource => {
      const { subject, snapshot } = vaultConfiguration(resource);
      return missingConfigurationBaseline(this.options.store, resource, subject, snapshot, now);
    }))).flat();
    await commitConfiguration(this.options.store, baselines, baselines, sources.map(resource => ({ ownerId: resource.ownerId, collection: resource.collection, id: resource.id, revision: resource.revision })));
    const latestParent = await this.activeVault(parent.ownerId, parent.id);
    const latest = await this.storedCredential(credential.ownerId, parent.id, credential.id);
    if (latest.value.status !== 'active') resourceNotFound();
    if (latestParent.revision !== parent.revision || latest.revision !== credential.revision) return undefined;
    return { kind: 'vault', vault: configurationRef({ kind: 'vault', id: parent.id }, parent.revision),
      credential: configurationRef({ kind: 'credential', vaultId: parent.id, id: credential.id }, credential.revision),
      checkedAt: this.clock.now(), destinationDigest: createHash('sha256').update(credentialUrl(serverUrl)).digest('hex') };
  }

  /** Every storage revision, including refresh fences, has a safe retained snapshot. */
  private async commit(writes: ConfigurationWrite[], mutation: ConfigurationMutation = { actor: { kind: 'system' } }): Promise<void> {
    const history: ConfigurationWrite[] = [];
    const baselines: ConfigurationWrite[] = [];
    for (const write of writes) {
      const previous = write.expectedRevision ? await this.options.store.get(write.resource.ownerId, write.resource.collection, write.resource.id) : undefined;
      if (write.expectedRevision && previous?.revision !== write.expectedRevision) throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
      const { subject, snapshot } = vaultConfiguration(write.resource);
      const before = previous ? vaultConfiguration(previous).snapshot : null;
      if (previous && before) baselines.push(...await missingConfigurationBaseline(this.options.store, previous, subject, before, this.clock.now()));
      history.push(planConfigurationRevision(write.resource.ownerId, configurationRef(subject, write.resource.revision), snapshot, before, this.clock.now(),
        !previous ? 'created' : snapshot.kind !== 'agent' && snapshot.kind !== 'session' && snapshot.status === 'archived' ? 'deleted' : mutation.actor?.kind === 'system' ? 'system' : 'updated', mutation));
    }
    await commitConfiguration(this.options.store, [...writes, ...baselines, ...history], history);
  }

  private async replace<T>(previous: AgentResource<T>, value: T, mutation: ConfigurationMutation = { actor: { kind: 'system' } }): Promise<AgentResource<T>> {
    const resource = { ...previous, value, revision: previous.revision + 1 };
    await this.commit([{ resource, expectedRevision: previous.revision }], mutation);
    return resource;
  }
}

function bearer(auth: CredentialAuthCreateParam): string {
  if (auth.type === 'environment_variable') resourceNotFound();
  return `Bearer ${auth.type === 'static_bearer' ? auth.token : auth.access_token}`;
}

function vaultConfiguration(resource: AgentResource<unknown>): { subject: ConfigurationSubject; snapshot: ConfigurationSnapshot } {
  if (resource.collection === 'vaults') {
    const value = resource.value as StoredVault;
    return { subject: { kind: 'vault', id: resource.id }, snapshot: { kind: 'vault', vault: value.vault, status: value.status } };
  }
  const value = resource.value as StoredCredential;
  return { subject: { kind: 'credential', vaultId: value.credential.vault_id, id: resource.id }, snapshot: { kind: 'credential', credential: value.credential, status: value.status } };
}
