import { createHash } from 'node:crypto';
import { sessionAgent } from '../core/session-planning.js';
import { THREAD_RELEASE_TOOL } from '../core/thread-release-tool.js';
import type { SessionState } from '../core/session-ports.js';
import type { StoredEnvironment } from '../core/environment-service.js';
import { CODEX_RUNTIME, type RuntimePin } from '../domain/session-runtime.js';
import { planConfigurationRevision, configurationRef } from '../core/configuration-history.js';
import type { Agent, AgentSession, EnvironmentParam } from '../domain/agents-api.js';
import type { AgentObservation, AgentResource, AgentsStore } from '../core/agents-ports.js';
import { AgentsApiError, invalid, parseAgentsContract } from '../domain/agents-api-validation.js';
import { resolveAgentConfiguration } from '../domain/agent-configuration.js';
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
export interface WorkloadConfiguration {
  agent: AgentSession['agent'];
  environment: EnvironmentParam;
  vault_ids: string[];
  runtime: RuntimePin;
}
export interface WorkloadAdmission {
  observations: AgentObservation[];
  evidence: {
    execution_role_id: string;
    execution_role_revision: number;
    agent_digest: string;
    source_agent_digest: string;
    capability_digest: string;
    configuration: WorkloadConfiguration;
    capability_profile_ids: string[];
    connection_grant_ids: string[];
    ceiling: ExecutionRole;
  };
}

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
    if (!(input.models as string[]).length || !Array.isArray(input.tools) || input.tools.length > 100 || !Array.isArray(input.environments) || !input.environments.length || input.environments.length > 20) invalid('Execution role requires models, tools, and allowed environments.');
    const agent = parseAgentsContract('AgentCreate', { model: (input.models as string[])[0], tools: input.tools });
    for (const environment of input.environments) {
      parseAgentsContract('SessionCreate', { agent: { model: agent.model }, environment });
      rejectEnvironmentSecrets(environment);
    }
    if (input.max_subagents !== undefined && (typeof input.max_subagents !== 'number' || !Number.isInteger(input.max_subagents) || input.max_subagents < 0 || input.max_subagents > 32)) invalid('Invalid max_subagents.');
    const tools = resolveAgentConfiguration(agent, { id: 'ceiling', created_at: 0, updated_at: 0 }).tools;
    const role = { ...input, id, tools } as unknown as ExecutionRole;
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
    return admittedWorkload(role, agent.value, agent.value, {
      agent: sessionAgent(undefined, agent.id, agent.createdAt, agent.value), environment: input.environment, vault_ids: input.vault_ids ?? [], runtime: CODEX_RUNTIME,
    }, [observation(agent), observation(assignment)]);
  }
  public async admitFork(authority: SpaceAuthority, sourceId: string): Promise<WorkloadAdmission> {
    const source = await this.store.get<SessionState>(authority.ownerId, 'sessions', sourceId);
    if (!source) throw new AgentsApiError(404, 'Session not found.', 'resource_not_found');
    const session = source.value.session;
    if (session.environment.type !== 'openai_hosted') invalid('Forks require a managed environment.', 'environment');
    const [agent, assignment] = await Promise.all([
      this.store.get<Agent>(authority.ownerId, 'agents', session.agent.id), this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', session.agent.id),
    ]);
    if (!agent || !assignment || assignment.value.agent_digest !== agentConfigurationDigest(agent.value)) denied('This Agent configuration needs a current workload assignment.');
    const role = await this.store.get<ExecutionRole>(authority.ownerId, 'execution_roles', assignment.value.execution_role_id);
    if (!role) denied('The assigned execution role is unavailable.');
    const childAgent = { ...session.agent, tools: session.agent.tools.filter(tool => tool.type !== 'function' || tool.name !== THREAD_RELEASE_TOOL.name) };
    const effective = parseAgentsContract('Agent', { ...agent.value, ...childAgent });
    validateAgentCeiling(agent.value, role.value);
    validateAgentCeiling(effective, role.value);
    const runtime = source.value.runtime ?? CODEX_RUNTIME;
    if (runtime.kind !== 'codex') denied('This execution ceiling has not admitted an alternate runtime.');
    const storedEnvironment = await this.store.get<StoredEnvironment>(authority.ownerId, 'environments', session.environment.id);
    if (!storedEnvironment?.value.configuration || storedEnvironment.value.environment.type !== 'openai_hosted') denied('The source environment configuration is unavailable for fork admission.');
    const environment: EnvironmentParam = { type: 'openai_hosted', ...storedEnvironment.value.configuration, network: session.environment.network };
    validateEnvironmentCeiling(environment, session.vault_ids, role.value);
    return admittedWorkload(role, agent.value, effective, { agent: childAgent, environment, vault_ids: session.vault_ids, runtime },
      [observation(source), observation(storedEnvironment), observation(agent), observation(assignment)]);
  }

  public async validateSessionUpdate(authority: SpaceAuthority, id: string, raw: unknown): Promise<void> {
    const input = parseAgentsContract('SessionUpdate', raw);
    if (input.agent?.model === undefined) return;
    const stored = await this.store.get<{ session: AgentSession; workloadAdmission?: { ceiling?: ExecutionRole } }>(authority.ownerId, 'sessions', id);
    if (!stored) throw new AgentsApiError(404, 'Session not found.', 'resource_not_found');
    if (input.agent.model !== stored.value.session.agent.model) denied('Changing the admitted model requires a new Session.');
  }
  public async admitShare(authority: SpaceAuthority, manifest: { source_agent?: Agent; session: Pick<AgentSession, 'agent' | 'vault_ids' | 'created_at'>; environment: EnvironmentParam; runtime?: RuntimePin }): Promise<WorkloadAdmission> {
    const source = manifest.source_agent ?? parseAgentsContract('Agent', { ...manifest.session.agent, object: 'agent', created_at: manifest.session.created_at, updated_at: manifest.session.created_at, metadata: {} });
    if (source.id !== manifest.session.agent.id) denied('Share requires the continuing Agent’s saved configuration.');
    const effective = parseAgentsContract('Agent', { ...source, ...manifest.session.agent });
    parseAgentsContract('Agent', source);
    const target = await this.store.get<Agent>(authority.ownerId, 'agents', source.id);
    if (target && agentConfigurationDigest(target.value) !== agentConfigurationDigest(source)) denied('The destination Agent identity has incompatible configuration.');
    const runtime = manifest.runtime ?? CODEX_RUNTIME;
    if (runtime.kind !== 'codex') denied('This execution ceiling has not admitted an alternate runtime.');
    const previous = await this.store.get<WorkloadAssignment>(authority.ownerId, 'agent_workloads', source.id);
    let role: AgentResource<ExecutionRole> | undefined;
    if (previous) {
      if (!target || previous.value.agent_digest !== agentConfigurationDigest(target.value)) denied('The existing Agent workload assignment is incompatible.');
      role = await this.store.get<ExecutionRole>(authority.ownerId, 'execution_roles', previous.value.execution_role_id);
      if (!role) denied('The assigned execution role is unavailable.');
      validateAgentCeiling(source, role.value);
      validateAgentCeiling(effective, role.value);
      validateEnvironmentCeiling(manifest.environment, manifest.session.vault_ids, role.value);
    } else {
      const roles = await this.store.list<ExecutionRole>(authority.ownerId, 'execution_roles', { limit: 100, order: 'asc' });
      role = roles.data.find(candidate => {
        try { validateAgentCeiling(source, candidate.value); validateAgentCeiling(effective, candidate.value); validateEnvironmentCeiling(manifest.environment, manifest.session.vault_ids, candidate.value); return true; }
        catch (error) { if (error instanceof AgentsApiError && error.status === 403) return false; throw error; }
      });
      if (!role) denied('The continuing Agent exceeds every configured execution ceiling.');
    }
    const assignment: WorkloadAssignment = { agent_id: source.id, execution_role_id: role.id, agent_digest: agentConfigurationDigest(source) };
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
    return admittedWorkload(role, source, effective, {
      agent: manifest.session.agent, environment: manifest.environment, vault_ids: manifest.session.vault_ids, runtime,
    }, [target ? observation(target) : { ownerId: authority.ownerId, collection: 'agents', id: source.id, revision: 1 },
      previous ? observation(previous) : { ownerId: authority.ownerId, collection: 'agent_workloads', id: source.id, revision: 1 }]);
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
  if (!role.environments.some(allowed => canonicalJson(environmentPolicy(allowed)) === canonicalJson(environmentPolicy(environment))) || vaultIds.some(id => !role.vault_ids.includes(id))) denied('Environment or Vault access exceeds the execution role.');
}
function rejectEnvironmentSecrets(environment: unknown) {
  if (!environment || typeof environment !== 'object') return;
  const record = environment as Record<string, unknown>;
  if (record.environment_template_id !== undefined) invalid('Execution ceilings require an explicit immutable environment.');
  if (record.env && Object.keys(record.env).length || record.environment_variables && Object.keys(record.environment_variables).length) invalid('Credentials and host environment do not belong in execution ceilings.');
}
function digest(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function denied(message: string): never { throw new AgentsApiError(403, message, 'insufficient_permissions'); }

function admittedWorkload(role: AgentResource<ExecutionRole>, source: Agent, effective: Agent, configuration: WorkloadConfiguration, dependencies: AgentObservation[]): WorkloadAdmission {
  return { observations: [...dependencies, observation(role)], evidence: {
    execution_role_id: role.id, execution_role_revision: role.revision,
    source_agent_digest: agentConfigurationDigest(source), agent_digest: agentConfigurationDigest(effective),
    capability_digest: digest({ configuration, policy: role.value }), configuration,
    capability_profile_ids: role.value.capability_profile_ids, connection_grant_ids: role.value.connection_grant_ids, ceiling: role.value,
  } };
}
function environmentPolicy(environment: EnvironmentParam): unknown {
  if (environment.type === 'none') return environment;
  if (environment.type === 'self_hosted') return { ...environment, capability_directories: environment.capability_directories ?? [] };
  return { ...environment,
    capability_directories: environment.capability_directories ?? [], env: environment.env ?? {},
    network: { access: environment.network?.access ?? 'disabled', allowed_domains: environment.network?.allowed_domains ?? [] },
    packages: { npm: environment.packages?.npm ?? [], python: environment.packages?.python ?? [], system: environment.packages?.system ?? [] },
    files: environment.files ?? [], plugins: environment.plugins ?? [], skills: environment.skills ?? [], setup_commands: environment.setup_commands ?? [],
  };
}
