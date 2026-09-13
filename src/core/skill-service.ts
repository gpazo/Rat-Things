import { createHash, randomUUID } from 'node:crypto';
import type { Skill, DeletedSkill, SkillListParams } from 'openai/resources/skills/skills';
import type { SkillVersion, DeletedSkillVersion, VersionListParams } from 'openai/resources/skills/versions/versions';
import type { AgentsStore, AgentsClock } from './agents-ports.js';
import type { ArtifactStore } from './ports.js';
import type { ArtifactReference } from '../domain/contracts.js';
import { capabilityArchive, type CapabilityFile } from '../domain/capability-archive.js';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { cursorPage } from './session-planning.js';

interface StoredSkill { skill: Skill; nextVersion: number; versions: Array<{ version: SkillVersion; content: ArtifactReference }> }

export class SkillService {
  public constructor(private readonly options: { store: AgentsStore; artifacts: Pick<ArtifactStore, 'putBytes' | 'getStream'>; clock?: AgentsClock }) {}
  private now() { return this.options.clock?.now() ?? Math.floor(Date.now() / 1000); }

  public async create(ownerId: string, files: CapabilityFile[]): Promise<Skill> {
    const id = `skill_${randomUUID().replaceAll('-', '')}`;
    const saved = await this.archive(ownerId, id, 1, files);
    const skill: Skill = { id, object: 'skill', created_at: saved.version.created_at, name: saved.version.name, description: saved.version.description, default_version: '1', latest_version: '1' };
    await this.options.store.put<StoredSkill>({ id, ownerId, collection: 'skills', createdAt: skill.created_at, revision: 1, value: { skill, nextVersion: 2, versions: [saved] } }, 0);
    return skill;
  }
  public async retrieve(ownerId: string, id: string) { return (await this.required(ownerId, id)).value.skill; }
  public async list(ownerId: string, query: SkillListParams = {}) {
    const page = await this.options.store.list<StoredSkill>(ownerId, 'skills', query);
    return list(page.data.map(({ value }) => value.skill), page.has_more);
  }
  public async update(ownerId: string, id: string, version: string): Promise<Skill> {
    const resource = await this.required(ownerId, id);
    const selected = selectVersion(resource.value, version);
    const skill = { ...resource.value.skill, name: selected.version.name, description: selected.version.description, default_version: selected.version.version };
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, skill } }, resource.revision);
    return skill;
  }
  public async delete(ownerId: string, id: string): Promise<DeletedSkill> {
    await this.options.store.delete(await this.required(ownerId, id));
    return { id, object: 'skill.deleted', deleted: true };
  }
  public async versions(ownerId: string, id: string, query: VersionListParams = {}) {
    const resource = await this.required(ownerId, id);
    const page = cursorPage(resource.value.versions.map(({ version }) => version), query);
    return list(page.data, page.has_more);
  }
  public async version(ownerId: string, id: string, version?: string | null) { return selectVersion((await this.required(ownerId, id)).value, version).version; }
  public async createVersion(ownerId: string, id: string, files: CapabilityFile[], makeDefault = false): Promise<SkillVersion> {
    const resource = await this.required(ownerId, id);
    const saved = await this.archive(ownerId, id, resource.value.nextVersion, files);
    const skill = { ...resource.value.skill, latest_version: saved.version.version,
      ...(makeDefault ? { default_version: saved.version.version, name: saved.version.name, description: saved.version.description } : {}) };
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { skill, nextVersion: resource.value.nextVersion + 1, versions: [...resource.value.versions, saved] } }, resource.revision);
    return saved.version;
  }
  public async deleteVersion(ownerId: string, id: string, version: string): Promise<DeletedSkillVersion> {
    const resource = await this.required(ownerId, id);
    const selected = selectVersion(resource.value, version);
    if (resource.value.versions.length === 1) {
      await this.options.store.delete(resource);
      return { id: selected.version.id, version: selected.version.version, object: 'skill.version.deleted', deleted: true };
    }
    if (selected.version.version === resource.value.skill.default_version) throw new AgentsApiError(409, 'Choose another default version before deleting this version.', 'conflict');
    const versions = resource.value.versions.filter((entry) => entry !== selected);
    const skill = { ...resource.value.skill, latest_version: versions.at(-1)!.version.version };
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, skill, versions } }, resource.revision);
    return { id: selected.version.id, version: selected.version.version, object: 'skill.version.deleted', deleted: true };
  }
  public async reference(ownerId: string, id: string, version?: string | null) { return selectVersion((await this.required(ownerId, id)).value, version); }
  public async content(ownerId: string, id: string, version?: string | null) { return this.options.artifacts.getStream((await this.reference(ownerId, id, version)).content); }

  private async archive(ownerId: string, id: string, number: number, files: CapabilityFile[]) {
    const archive = capabilityArchive(files, 'skill');
    const digest = createHash('sha256').update(archive.zip).digest('hex');
    const owner = createHash('sha256').update(ownerId).digest('hex');
    const content = await this.options.artifacts.putBytes(`owners/${owner}/skills/${id}/${number}/${digest}.zip`, archive.zip, 'application/zip');
    const version: SkillVersion = { id: `skillver_${randomUUID().replaceAll('-', '')}`, object: 'skill.version', skill_id: id, version: String(number), name: archive.name, description: archive.description, created_at: this.now() };
    return { version, content };
  }
  private async required(ownerId: string, id: string) { return await this.options.store.get<StoredSkill>(ownerId, 'skills', id) ?? resourceNotFound(); }
}

function selectVersion(state: StoredSkill, selected?: string | null) {
  const version = selected === 'latest' ? state.skill.latest_version : selected ?? state.skill.default_version;
  return state.versions.find((entry) => entry.version.version === version) ?? resourceNotFound();
}
function list<T extends { id: string }>(data: T[], has_more: boolean) { return { object: 'list' as const, data, has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }; }
