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

  public async create(ownerId: string, raw: unknown): Promise<Agent> {
    const input = parseAgentsContract('AgentCreate', raw);
    const timestamp = this.clock.now();
    const agent = resolveAgentConfiguration(input, {
      id: this.ids.next('agent'), created_at: timestamp, updated_at: timestamp,
    }, undefined, this.options.defaults);
    await this.options.store.put({
      id: agent.id, ownerId, collection: 'agents', createdAt: timestamp, revision: 1, value: agent,
    }, 0);
    return agent;
  }

  public async retrieve(ownerId: string, id: string): Promise<Agent> {
    return (await this.required(ownerId, id)).value;
  }

  public async update(ownerId: string, id: string, raw: unknown): Promise<Agent> {
    const input = parseAgentsContract('AgentUpdate', raw);
    const previous = await this.required(ownerId, id);
    const agent = resolveAgentConfiguration(input, {
      id, created_at: previous.value.created_at, updated_at: this.clock.now(),
    }, previous.value, this.options.defaults);
    await this.options.store.put({ ...previous, value: agent, revision: previous.revision + 1 }, previous.revision);
    return agent;
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

  public async delete(ownerId: string, id: string): Promise<AgentDeleted> {
    await this.options.store.delete(await this.required(ownerId, id));
    return { id, object: 'agent.deleted', deleted: true };
  }

  private async required(ownerId: string, id: string) {
    const resource = await this.options.store.get<Agent>(ownerId, 'agents', id);
    return resource ?? resourceNotFound();
  }
}
