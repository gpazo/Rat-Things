import type { AgentSession, AgentToolParam } from '../domain/agents-api.js';
import type { SessionToolSecrets } from '../credentials/session-tools.js';
import type { AgentsClock, AgentsStore } from './agents-ports.js';
import type { VaultService } from './vault-service.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import type { SessionMcpBinding } from '../domain/session-execution.js';

/** Separate public MCP settings from confidential transports before saving a session. */
export class SessionToolService {
  public constructor(private readonly options: { store: AgentsStore; secrets: SessionToolSecrets; vaults: Pick<VaultService, 'resolve' | 'requireVaults'>; clock?: AgentsClock }) {}

  public async prepare(ownerId: string, sessionId: string, agent: AgentSession['agent'], tools: AgentToolParam[], vaultIds: string[], resumePreparation = false): Promise<void> {
    if (resumePreparation && await this.options.store.get(ownerId, 'session_tools', sessionId)) return;
    await this.options.vaults.requireVaults(ownerId, vaultIds);
    const prepared: Array<{ serverLabel: string; headers: Record<string, string>; env: Record<string, string> }> = [];
    for (const tool of tools) {
      if (tool.type !== 'mcp') continue;
      const resolved = agent.tools.find((candidate) => candidate.type === 'mcp' && candidate.server_label === tool.server_label);
      if (!resolved || resolved.type !== 'mcp') throw new Error('MCP configuration does not match the session');
      const headers = tool.transport.type === 'http' ? { ...tool.transport.headers, ...(tool.transport.authorization != null ? { Authorization: tool.transport.authorization } : {}) } : {};
      const env = tool.transport.type === 'stdio' ? tool.transport.env ?? {} : {};
      if (Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization').length > 1) invalid('MCP authorization must have exactly one source', 'agent.tools.transport');
      if (Buffer.byteLength(JSON.stringify({ headers, env })) > 60_000) invalid('MCP credentials exceed the secret size limit', 'agent.tools.transport');
      if (resolved.transport.type === 'http' && resolved.connection_origin === 'service') {
        const credential = await this.options.vaults.resolve(ownerId, vaultIds, resolved.transport.server_url, resolved.credential_id, true);
        if (credential && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) invalid('MCP authorization must have exactly one source', 'agent.tools.transport');
      }
      if (tool.transport.type === 'stdio' && resolved.connection_origin !== 'environment') invalid('Stdio MCP servers require an execution environment', 'agent.tools.connection_origin');
      prepared.push({ serverLabel: tool.server_label, headers, env });
    }
    const bindings: SessionMcpBinding[] = [];
    const discard = () => Promise.allSettled(bindings.flatMap((binding) => binding.inlineReference ? [this.options.secrets.revoke(binding.inlineReference)] : []));
    try {
      for (const { serverLabel, headers, env } of prepared) bindings.push({ serverLabel, ...(Object.keys(headers).length || Object.keys(env).length ? {
        inlineReference: await this.options.secrets.create({ ownerId, sessionId, serverLabel, headers, env }),
      } : {}) });
    } catch (error) { await discard(); throw error; }
    try { await this.options.store.put({ ownerId, id: sessionId, collection: 'session_tools', createdAt: this.options.clock?.now() ?? Math.floor(Date.now() / 1000), revision: 1, value: bindings }, 0); }
    catch (error) { if (error instanceof AgentsApiError && error.status === 409) { await discard(); if (resumePreparation) return; } throw error; }
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
    for (const binding of resource.value) if (binding.inlineReference) await this.options.secrets.revoke(binding.inlineReference);
    await this.options.store.delete(resource);
  }
}
