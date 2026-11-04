import { commitConfiguration, configurationConflict, configurationRef, missingConfigurationBaseline, planConfigurationRevision, retainConfiguration } from './configuration-history.js';
import type { ConfigurationMutation } from '../domain/configuration-history.js';
import { randomUUID } from 'node:crypto';
import type { Agent, AgentDeleted } from '../domain/agents-api.js';
import { resolveAgentConfiguration, type AgentConfigurationDefaults } from '../domain/agent-configuration.js';
import { invalid, parseAgentsContract, resourceNotFound } from '../domain/agents-api-validation.js';
import type { AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';

export interface AgentServiceOptions {
  store: AgentsStore;
  clock?: AgentsClock;
  ids?: AgentsIds;
  defaults?: AgentConfigurationDefaults;
}

export class AgentService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;

  public constructor(private readonly options: AgentServiceOptions) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }

  public async create(ownerId: string, raw: unknown, mutation: ConfigurationMutation = {}): Promise<Agent> {
    const input = parseAgentsContract('AgentCreate', raw);
    const timestamp = this.clock.now();
    const agent = resolveAgentConfiguration(input, {
      id: this.ids.next('agent'), created_at: timestamp, updated_at: timestamp,
    }, undefined, this.options.defaults);
    const resource = { id: agent.id, ownerId, collection: 'agents', createdAt: timestamp, revision: 1, value: agent };
    const history = planConfigurationRevision(ownerId, configurationRef({ kind: 'agent', id: agent.id }, 1), { kind: 'agent', agent }, null, timestamp, 'created', mutation);
    await commitConfiguration(this.options.store, [{ resource, expectedRevision: 0 }, history], [history]);
    return agent;
  }

  public async retrieve(ownerId: string, id: string): Promise<Agent> {
    return (await this.required(ownerId, id)).value;
  }

  public async update(ownerId: string, id: string, raw: unknown, mutation: ConfigurationMutation = {}): Promise<Agent> {
    const input = parseAgentsContract('AgentUpdate', raw);
    for (let attempt = 0; ; attempt++) {
      const previous = await this.required(ownerId, id);
      const now = this.clock.now();
      const agent = resolveAgentConfiguration(input, { id, created_at: previous.value.created_at, updated_at: now }, previous.value, this.options.defaults);
      const subject = { kind: 'agent' as const, id };
      const snapshot = { kind: 'agent' as const, agent: previous.value };
      const baseline = await missingConfigurationBaseline(this.options.store, previous, subject, snapshot, now);
      const history = planConfigurationRevision(ownerId, configurationRef(subject, previous.revision + 1), { kind: 'agent', agent }, snapshot, now, 'updated', mutation);
      try {
        await commitConfiguration(this.options.store, [{ resource: { ...previous, value: agent, revision: previous.revision + 1 }, expectedRevision: previous.revision }, ...baseline, history], [history]);
        return agent;
      } catch (error) { if (!configurationConflict(error) || attempt >= 9) throw error; }
    }
  }

  public async configuration(ownerId: string, id: string) {
    for (let attempt = 0; ; attempt++) {
      const resource = await this.required(ownerId, id);
      try {
        const revision = await retainConfiguration(this.options.store, resource, { kind: 'agent', id }, { kind: 'agent', agent: resource.value }, this.clock.now());
        return { agent: resource.value, revision };
      } catch (error) { if (!configurationConflict(error) || attempt >= 9) throw error; }
    }
  }

  public async list(ownerId: string, raw: unknown = {}) {
    const query = parseAgentsContract('AgentList', raw);
    if (query.limit != null && (!Number.isInteger(query.limit) || query.limit < 1)) {
      invalid('limit must be a positive integer', 'limit');
    }
    const page = await this.options.store.list<Agent>(ownerId, 'agents', query);
    const data = page.data.map((resource) => resource.value);
    return { object: 'list' as const, data, has_more: page.has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  }

  public async delete(ownerId: string, id: string, mutation: ConfigurationMutation = {}): Promise<AgentDeleted> {
    for (let attempt = 0; ; attempt++) {
      const previous = await this.required(ownerId, id);
      const subject = { kind: 'agent' as const, id };
      const snapshot = { kind: 'agent' as const, agent: previous.value };
      const baseline = await missingConfigurationBaseline(this.options.store, previous, subject, snapshot, this.clock.now());
      const history = planConfigurationRevision(ownerId, configurationRef(subject, previous.revision + 1), null, snapshot, this.clock.now(), 'deleted', mutation);
      try { await commitConfiguration(this.options.store, [...baseline, history], [history], undefined, previous); break; }
      catch (error) { if (!configurationConflict(error) || attempt >= 9) throw error; }
    }
    return { id, object: 'agent.deleted', deleted: true };
  }

  private async required(ownerId: string, id: string) {
    const resource = await this.options.store.get<Agent>(ownerId, 'agents', id);
    return resource ?? resourceNotFound();
  }
}
