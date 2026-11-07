import { createHash } from 'node:crypto';
import { planConfigurationRevision, configurationRef } from '../core/configuration-history.js';
import type { Agent, AgentSession, EnvironmentParam } from '../domain/agents-api.js';
import type { AgentObservation, AgentsStore } from '../core/agents-ports.js';
import { AgentsApiError, invalid, parseAgentsContract } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import { observation, record, type SpaceAuthority } from './space-access.js';
import { requireUnexpired } from './principal.js';

export interface ExecutionRole {
  id: string;
  name: string;
  models: string[];
  tools: Agent['tools'];
  environments: EnvironmentParam[];
  vault_ids: string[];
  capability_profile_ids: string[];
  connection_grant_ids: string[];
  max_subagents?: number;
}
export interface WorkloadAssignment { agent_id: string; execution_role_id: string; agent_digest: string }
export interface WorkloadAdmission { observations: AgentObservation[]; evidence: { execution_role_id: string; agent_digest: string; capability_digest: string; capability_profile_ids: string[]; connection_grant_ids: string[] } }

/** Capability roles admit saved configurations. Human roles never become runtime tool authority. */
export class WorkloadAdmissionService {
  public constructor(private readonly store: AgentsStore) {}
  public async roles(authority: SpaceAuthority) {
    const page = await this.store.list<ExecutionRole>(authority.ownerId, 'execution_roles', { limit: 100 });
    return { data: page.data.map(item => item.value), has_more: page.has_more };
  }
  public async setRole(authority: SpaceAuthority, id: string, raw: unknown) {
    const input = record(raw, ['name', 'models', 'tools', 'environments', 'vault_ids', 'capability_profile_ids', 'connection_grant_ids', 'max_subagents']);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof input.name !== 'string' || !input.name || input.name.length > 128) invalid('Invalid execution role.');
    for (const key of ['models', 'vault_ids', 'capability_profile_ids', 'connection_grant_ids']) {
      if (!Array.isArray(input[key]) || (input[key] as unknown[]).length > 100 || (input[key] as unknown[]).some(v => typeof v !== 'string' || !v || v.length > 256)) invalid(`Invalid ${key}.`);
    }
    if ((input.capability_profile_ids as string[]).length || (input.connection_grant_ids as string[]).length) invalid('Capability profile and connection grant references are not supported by Session execution. These arrays must be empty.');
    if (!(input.models as string[]).length || !Array.isArray(input.tools) || !Array.isArray(input.environments) || !input.environments.length || input.environments.length > 20) invalid('Execution role requires models, tools, and allowed environments.');
    const agent = parseAgentsContract('AgentCreate', { model: (input.models as string[])[0], tools: input.tools });
    for (const environment of input.environments) {
      parseAgentsContract('SessionCreate', { agent: { model: agent.model }, environment });
      rejectEnvironmentSecrets(environment);
    }
    if (input.max_subagents !== undefined && (typeof input.max_subagents !== 'number' || !Number.isInteger(input.max_subagents) || input.max_subagents < 0 || input.max_subagents > 32)) invalid('Invalid max_subagents.');
    const role = { ...input, id } as unknown as ExecutionRole;
    const previous = await this.store.get<ExecutionRole>(authority.ownerId, 'execution_roles', id);
    await authority.revalidate(); requireUnexpired(authority);
    await this.store.commit([{ resource: { ownerId: authority.ownerId, collection: 'execution_roles', id, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? Math.floor(Date.now() / 1000), value: role }, expectedRevision: previous?.revision ?? 0 }], authority.observations);
    return role;
  }
  public async assignment(authority: SpaceAuthority, agentId: string) {
    return (await this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', agentId))?.value ?? null;
  }
  public async assign(authority: SpaceAuthority, agentId: string, raw: unknown) {
    const input = record(raw, ['execution_role_id']);
    if (typeof input.execution_role_id !== 'string') invalid('execution_role_id is required.');
    const [agent, role, previous] = await Promise.all([
      this.store.get<Agent>(authority.ownerId, 'agents', agentId), this.store.get<ExecutionRole>(authority.ownerId, 'execution_roles', input.execution_role_id),
      this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', agentId),
    ]);
    if (!agent || !role) denied('Saved Agent and execution role must exist in this space.');
    validateAgentCeiling(agent.value, role.value);
    const assignment: WorkloadAssignment = { agent_id: agentId, execution_role_id: role.id, agent_digest: agentConfigurationDigest(agent.value) };
    await authority.revalidate(); requireUnexpired(authority);
    await this.store.commit([{ resource: { ownerId: authority.ownerId, collection: 'agent_workloads', id: agentId, createdAt: previous?.createdAt ?? Math.floor(Date.now() / 1000), revision: (previous?.revision ?? 0) + 1, value: assignment }, expectedRevision: previous?.revision ?? 0 }], [...authority.observations, observation(agent), observation(role)]);
    return assignment;
  }
  public async admit(authority: SpaceAuthority, raw: unknown): Promise<WorkloadAdmission> {
    const input = parseAgentsContract('SessionCreate', raw);
    if (!input.agent_id || input.agent !== undefined) denied('Select an assigned saved Agent without inline overrides.');
    const [agent, assignment] = await Promise.all([
      this.store.get<Agent>(authority.ownerId, 'agents', input.agent_id), this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', input.agent_id),
    ]);
    if (!agent || !assignment || assignment.value.agent_digest !== agentConfigurationDigest(agent.value)) denied('This Agent configuration needs a current workload assignment.');
    for (const [key, value] of Object.entries(input.metadata ?? {})) if (key.startsWith('rat_things_') && agent.value.metadata?.[key] !== value) denied('Session metadata cannot override admitted runtime policy.');
    const role = await this.store.get<ExecutionRole>(authority.ownerId, 'execution_roles', assignment.value.execution_role_id);
    if (!role) denied('The assigned execution role is unavailable.');
    validateAgentCeiling(agent.value, role.value);
    validateEnvironmentCeiling(input.environment, input.vault_ids ?? [], role.value);
    return { observations: [observation(agent), observation(assignment), observation(role)], evidence: {
      execution_role_id: role.id, agent_digest: assignment.value.agent_digest,
      capability_digest: digest({ agent: agentConfigurationDigest(agent.value), environment: input.environment, vault_ids: input.vault_ids ?? [], policy: role.value }),
      capability_profile_ids: role.value.capability_profile_ids, connection_grant_ids: role.value.connection_grant_ids,
    } };
  }
  public async admitShare(authority: SpaceAuthority, manifest: { source_agent?: Agent; session: Pick<AgentSession, 'agent' | 'vault_ids' | 'created_at'>; environment: EnvironmentParam }): Promise<WorkloadAdmission> {
    const source = manifest.source_agent ?? parseAgentsContract('Agent', { ...manifest.session.agent, object: 'agent', created_at: manifest.session.created_at, updated_at: manifest.session.created_at, metadata: {} });
    if (source.id !== manifest.session.agent.id) denied('Share requires the continuing Agent’s saved configuration.');
    const effective = parseAgentsContract('Agent', { ...source, ...manifest.session.agent });
    parseAgentsContract('Agent', source);
    const target = await this.store.get<Agent>(authority.ownerId, 'agents', source.id);
    if (target && agentConfigurationDigest(target.value) !== agentConfigurationDigest(source)) denied('The destination Agent identity has incompatible configuration.');
    const roles = await this.store.list<ExecutionRole>(authority.ownerId, 'execution_roles', { limit: 100, order: 'asc' });
    const role = roles.data.find(candidate => {
      try { validateAgentCeiling(source, candidate.value); validateAgentCeiling(effective, candidate.value); validateEnvironmentCeiling(manifest.environment, manifest.session.vault_ids, candidate.value); return true; }
      catch (error) { if (error instanceof AgentsApiError && error.status === 403) return false; throw error; }
    });
    if (!role) denied('The continuing Agent exceeds every configured execution ceiling.');
    const previous = await this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', source.id);
    const assignment: WorkloadAssignment = { agent_id: source.id, execution_role_id: role.id, agent_digest: agentConfigurationDigest(source) };
    if (target && previous && previous.value.agent_digest !== assignment.agent_digest) denied('The existing Agent workload assignment is incompatible.');
    const now = Math.floor(Date.now() / 1000);
    const writes: Parameters<AgentsStore['commit']>[0] = [];
    if (!target) {
      writes.push({ resource: { ownerId: authority.ownerId, id: source.id, collection: 'agents', createdAt: source.created_at, revision: 1, value: source }, expectedRevision: 0 });
      writes.push(planConfigurationRevision(authority.ownerId, configurationRef({ kind: 'agent', id: source.id }, 1), { kind: 'agent', agent: source }, null, now, 'created', { actor: { kind: 'principal', id: authority.actor.id } }));
    }
    if (!previous) writes.push({ resource: { ownerId: authority.ownerId, id: source.id, collection: 'agent_workloads', createdAt: now, revision: 1, value: assignment }, expectedRevision: 0 });
    if (writes.length) {
      await authority.revalidate(); requireUnexpired(authority);
      await this.store.commit(writes, [...authority.observations, observation(role), ...(target ? [observation(target)] : []), ...(previous ? [observation(previous)] : [])]);
    }
    return this.admit(authority, { agent_id: source.id, environment: manifest.environment, vault_ids: manifest.session.vault_ids });
  }
}
export function agentConfigurationDigest(agent: Agent): string {
  const { id: _id, created_at: _created, updated_at: _updated, object: _object, ...configuration } = agent;
  return digest(configuration);
}
function validateAgentCeiling(agent: Agent, role: ExecutionRole) {
  if (agent.multi_agent.enabled && (agent.multi_agent.max_concurrent_subagents ?? 6) > (role.max_subagents ?? 0)) denied('Agent subagent capacity exceeds the execution role.');
  if (agent.metadata?.rat_things_runtime && agent.metadata.rat_things_runtime !== 'codex') denied('This execution ceiling has not admitted an alternate runtime.');
  if (!role.models.includes(agent.model) || agent.tools.some(tool => !role.tools.some(allowed => canonicalJson(allowed) === canonicalJson(tool)))) denied('Agent tools or model exceed the execution role.');
}
function validateEnvironmentCeiling(environment: EnvironmentParam, vaultIds: string[], role: ExecutionRole) {
  if (!role.environments.some(allowed => canonicalJson(allowed) === canonicalJson(environment)) || vaultIds.some(id => !role.vault_ids.includes(id))) denied('Environment or Vault access exceeds the execution role.');
}
function rejectEnvironmentSecrets(environment: unknown) {
  if (!environment || typeof environment !== 'object') return;
  const record = environment as Record<string, unknown>;
  if (record.type === 'template') invalid('Execution ceilings require an explicit immutable environment.');
  if (record.env && Object.keys(record.env).length || record.environment_variables && Object.keys(record.environment_variables).length) invalid('Credentials and host environment do not belong in execution ceilings.');
}
function digest(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function denied(message: string): never { throw new AgentsApiError(403, message, 'insufficient_permissions'); }
