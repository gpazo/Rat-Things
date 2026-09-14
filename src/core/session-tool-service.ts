import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentToolParam } from '../domain/agents-api.js';
import type { SessionToolSecrets } from '../credentials/session-tools.js';
import type { AgentResource, AgentsClock, AgentsStore } from './agents-ports.js';
import type { VaultService } from './vault-service.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import type { SessionMcpBinding } from '../domain/session-execution.js';
import { planSessionToolCommitRecovery, planSessionToolTransports, planSessionToolReconciliation, type SessionToolAttempt } from './session-tool-planning.js';
import { planPreparationReconciliation, requireActivePreparation, type SessionPreparation } from './session-preparation-planning.js';

/** Separate public MCP settings from confidential transports before saving a session. */
export class SessionToolService {
  public constructor(private readonly options: { store: AgentsStore; secrets: SessionToolSecrets; vaults: Pick<VaultService, 'resolve' | 'requireVaults'>; clock?: AgentsClock }) {}

  public async prepare(ownerId: string, sessionId: string, agent: AgentSession['agent'], tools: AgentToolParam[], vaultIds: string[], resumePreparation = false): Promise<void> {
    const preparation = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', sessionId);
    if (preparation && !preparation.value.created) requireActivePreparation(preparation.value, this.now());
    if (resumePreparation && await this.options.store.get(ownerId, 'session_tools', sessionId)) return;
    const prepared = planSessionToolTransports(agent, tools);
    await this.options.vaults.requireVaults(ownerId, vaultIds);
    for (const { resolved, headers } of prepared) {
      if (resolved.transport.type === 'http' && resolved.connection_origin === 'service') {
        const credential = await this.options.vaults.resolve(ownerId, vaultIds, resolved.transport.server_url, resolved.credential_id, true);
        if (credential && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) invalid('MCP authorization must have exactly one source', 'agent.tools.transport');
      }
    }
    const attemptId = randomUUID();
    const bindings = prepared.map(({ serverLabel, headers, env }) => ({ serverLabel,
      ...(Object.keys(headers).length || Object.keys(env).length ? {
        inlineReference: this.options.secrets.reference({ ownerId, sessionId, serverLabel }, attemptId),
      } : {}),
    }));
    const attempt: AgentResource<SessionToolAttempt> = { ownerId, id: attemptId, collection: 'session_tool_attempts',
      createdAt: this.now(), revision: 1, value: { sessionId, bindings, status: 'pending', deadline: this.now() + 300 },
    };
    // An uncertain intent write creates no secrets. Its stream event still
    // retires all reserved names if the write eventually commits.
    await this.options.store.put(attempt, 0);
    try {
      for (const [index, transport] of prepared.entries()) {
        const reference = bindings[index]?.inlineReference;
        if (!reference) continue;
        const current = await this.options.store.get<SessionToolAttempt>(ownerId, attempt.collection, attempt.id);
        if (current?.value.status !== 'pending' || this.now() >= current.value.deadline) throw new AgentsApiError(409, 'Session tool preparation expired.', 'conflict');
        const { serverLabel, headers, env } = transport;
        await this.options.secrets.create({ ownerId, sessionId, serverLabel, headers, env }, reference);
      }
      await this.options.store.commit([
        { resource: { ownerId, id: sessionId, collection: 'session_tools', createdAt: attempt.createdAt, revision: 1, value: bindings }, expectedRevision: 0 },
        { resource: { ...attempt, revision: 2, value: { ...attempt.value, status: 'adopted' } }, expectedRevision: 1 },
        // The same revision fences credential adoption and final Session commit
        // against abandonment, including a creator paused during secret access.
        ...(preparation ? [{ resource: { ...preparation, revision: preparation.revision + 1 }, expectedRevision: preparation.revision }] : []),
      ]);
    } catch (error) {
      // Cleanup failures leave a durable attempt for the outbox. Never infer
      // absence from a failed read or revoke before the cleanup fence commits.
      const result = await this.reconcile(ownerId, attempt.id, true).catch(() => undefined);
      if (result?.status === 'adopted') return;
      const winner = await this.options.store.get<SessionMcpBinding[]>(ownerId, 'session_tools', sessionId).catch(() => undefined);
      if (winner && (resumePreparation || planSessionToolCommitRecovery(bindings, winner.value).adopted)) return;
      throw error;
    }
  }

  /** Expiry closes adopted inline bindings only after fencing Session creation. */
  public async reconcilePreparation(ownerId: string, sessionId: string): Promise<{ status: 'created' | 'legacy' | 'cleaned' | 'waiting'; retryAfterSeconds?: number }> {
    const resource = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', sessionId);
    if (!resource) return { status: 'cleaned' };
    const plan = planPreparationReconciliation(resource.value, this.now());
    if (plan.type === 'created' || plan.type === 'legacy') return { status: plan.type };
    if (plan.type === 'wait') return { status: 'waiting', retryAfterSeconds: plan.retryAfterSeconds };
    if (!resource.value.abandoned) {
      await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, abandoned: true } }, resource.revision);
    }
    await this.close(ownerId, sessionId);
    return { status: 'cleaned' };
  }

  /** Retryable outbox work contains references only, never credential values. */
  public async reconcile(ownerId: string, attemptId: string, abandon = false): Promise<{ status: 'adopted' | 'cleaned' | 'waiting'; retryAfterSeconds?: number }> {
    const resource = await this.options.store.get<SessionToolAttempt>(ownerId, 'session_tool_attempts', attemptId);
    if (!resource) return { status: 'cleaned' };
    const plan = planSessionToolReconciliation(resource.value, this.now(), abandon);
    if (plan.type === 'wait') return { status: 'waiting', retryAfterSeconds: plan.retryAfterSeconds };
    if (plan.type === 'adopted') {
      await this.options.store.delete(resource);
      return { status: 'adopted' };
    }
    const cleanup: AgentResource<SessionToolAttempt> = resource.value.status === 'cleanup' ? resource
      : { ...resource, revision: resource.revision + 1, value: { ...resource.value, status: 'cleanup' } };
    if (cleanup !== resource) await this.options.store.put(cleanup, resource.revision);
    const committed = await this.options.store.get<SessionMcpBinding[]>(ownerId, 'session_tools', resource.value.sessionId);
    const { revoke } = planSessionToolCommitRecovery(resource.value.bindings, committed?.value ?? []);
    for (const reference of revoke) await this.options.secrets.revoke(reference);
    await this.options.store.delete(cleanup);
    return { status: 'cleaned' };
  }

  /** Recheck attached vault grants on every turn, including credential rotation and deletion. */
  public async launch(ownerId: string, session: AgentSession): Promise<SessionMcpBinding[]> {
    await this.options.vaults.requireVaults(ownerId, session.vault_ids);
    const saved = (await this.options.store.get<SessionMcpBinding[]>(ownerId, 'session_tools', session.id))?.value ?? [];
    return Promise.all(saved.map(async (binding) => {
      const tool = session.agent.tools.find((candidate) => candidate.type === 'mcp' && candidate.server_label === binding.serverLabel);
      if (!tool || tool.type !== 'mcp' || tool.transport.type !== 'http' || tool.connection_origin !== 'service') return binding;
      if (!tool.credential_id && !session.vault_ids.length) return binding;
      const credential = await this.options.vaults.resolve(ownerId, session.vault_ids, tool.transport.server_url, tool.credential_id, true);
      return credential ? { ...binding, vaultReference: credential.reference, vaultId: credential.credential.vault_id, credentialId: credential.credential.id } : binding;
    }));
  }

  public async close(ownerId: string, sessionId: string): Promise<void> {
    const resource = await this.options.store.get<SessionMcpBinding[]>(ownerId, 'session_tools', sessionId);
    if (!resource) return;
    const cleanup: AgentResource<SessionToolAttempt> = { ownerId, id: randomUUID(), collection: 'session_tool_attempts',
      createdAt: this.now(), revision: 1, value: { sessionId, bindings: resource.value, status: 'cleanup', deadline: this.now() },
    };
    // Removing bindings and recording their cleanup are one transaction. A
    // lost acknowledgement cannot discard the outbox's recovery path.
    await this.options.store.delete(resource, [{ resource: cleanup, expectedRevision: 0 }]);
    await this.reconcile(ownerId, cleanup.id);
  }

  private now(): number { return this.options.clock?.now() ?? Math.floor(Date.now() / 1000); }
}
