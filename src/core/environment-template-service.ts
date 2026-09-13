import { randomUUID } from 'node:crypto';
import type { EnvironmentTemplate, EnvironmentTemplateDeleted, TemplateCreateParams } from '../domain/agents-api.js';
import { parseAgentsContract, resourceNotFound } from '../domain/agents-api-validation.js';
import { publicTemplate, resolveHostedEnvironment, templateConfiguration, type HostedEnvironmentConfiguration } from '../domain/environment-planning.js';
import type { AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';

interface StoredTemplate { template: EnvironmentTemplate; configuration: TemplateCreateParams }

export class EnvironmentTemplateService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;

  public constructor(private readonly options: { store: AgentsStore; clock?: AgentsClock; ids?: AgentsIds }) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }

  public async create(ownerId: string, raw: unknown = {}): Promise<EnvironmentTemplate> {
    const configuration = templateConfiguration(parseAgentsContract('EnvironmentTemplateCreate', raw));
    const now = this.clock.now();
    const template = publicTemplate(configuration, { id: this.ids.next('envtmpl'), created_at: now, updated_at: now });
    await this.options.store.put({ id: template.id, ownerId, collection: 'environment_templates', createdAt: now, revision: 1, value: { template, configuration } }, 0);
    return template;
  }

  public async retrieve(ownerId: string, id: string) { return (await this.required(ownerId, id)).value.template; }

  public async update(ownerId: string, id: string, raw: unknown): Promise<EnvironmentTemplate> {
    const input = parseAgentsContract('EnvironmentTemplateUpdate', raw);
    const previous = await this.required(ownerId, id);
    const configuration = templateConfiguration(input, previous.value.configuration);
    const template = publicTemplate(configuration, { id, created_at: previous.createdAt, updated_at: this.clock.now() });
    await this.options.store.put({ ...previous, revision: previous.revision + 1, value: { template, configuration } }, previous.revision);
    return template;
  }

  public async list(ownerId: string, raw: unknown = {}) {
    const query = parseAgentsContract('EnvironmentTemplateList', raw);
    const page = await this.options.store.list<StoredTemplate>(ownerId, 'environment_templates', query);
    return { object: 'list' as const, data: page.data.map(({ value }) => value.template), has_more: page.has_more };
  }

  public async delete(ownerId: string, id: string): Promise<EnvironmentTemplateDeleted> {
    await this.options.store.delete(await this.required(ownerId, id));
    return { id, object: 'agent.environment.template.deleted', deleted: true };
  }

  /** Only trusted environment preparation can request the confidential configuration. */
  public async resolve(ownerId: string, id: string | undefined, inline: HostedEnvironmentConfiguration) {
    const template = id ? (await this.required(ownerId, id)).value.configuration : undefined;
    return resolveHostedEnvironment(template, inline);
  }

  private async required(ownerId: string, id: string) { return await this.options.store.get<StoredTemplate>(ownerId, 'environment_templates', id) ?? resourceNotFound(); }
}
