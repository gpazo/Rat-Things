import { describe, expect, it } from 'vitest';
import OpenAI, { toFile } from 'openai';
import { zipSync } from 'fflate';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../../src/core/file-service.js';
import { SkillService } from '../../src/core/skill-service.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { MemoryAgentsStore } from './fixtures.js';
import { MemoryArtifacts } from '../runner/artifact-fixtures.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { capabilityArchive } from '../../src/domain/capability-archive.js';
import { prepareHostedEnvironment } from '../../src/runner/hosted-environment.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

const skillFile = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: Read a report.\n---\nRead the supplied report.\n`);
function fixture() {
  const store = new MemoryAgentsStore();
  const artifacts = new MemoryArtifacts();
  const files = new FileService({ store, artifacts });
  const skills = new SkillService({ store, artifacts });
  const templates = new EnvironmentTemplateService({ store });
  const agents = new AgentService({ store });
  const environments = new EnvironmentService({ store, templates, uploadedFiles: files, skills, credentials: { create: async () => 'unused', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} }, managedFiles: async () => [] });
  const client = (owner: string) => new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: (input, init) => routeAgentsRequest(new Request(input, init), owner, { agents, files, skills, environments, templates }) });
  return { artifacts, files, skills, templates, environments, api: client('alice'), other: client('bob') };
}

describe('uploaded files, skills, and managed setup', () => {
  it('accepts Unicode skill names and per-file limits even when the archive expands beyond 50 MiB', async () => {
    const part = new Uint8Array(18 * 1024 * 1024);
    const archive = capabilityArchive([{ path: 'skill.zip', data: zipSync({
      'résumé-reader/SKILL.md': skillFile('résumé-reader'),
      'résumé-reader/a.bin': part, 'résumé-reader/b.bin': part, 'résumé-reader/c.bin': part,
    }) }], 'skill');
    expect(archive.name).toBe('résumé-reader');
    expect(archive.files.slice(1).map((file) => file.data.byteLength)).toEqual([part.byteLength, part.byteLength, part.byteLength]);
    const f = fixture();
    const skill = await f.api.skills.create({ files: [await toFile(skillFile('résumé-reader'), 'résumé-reader/SKILL.md')] });
    parseAgentsContract('Skill', skill);
    parseAgentsContract('SkillVersionDeleted', await f.api.skills.versions.delete('1', { skill_id: skill.id }));
    await expect(f.api.skills.retrieve(skill.id)).rejects.toMatchObject({ status: 404 });
  });

  it('uploads binary files through the SDK, streams unchanged bytes, and applies owner and deletion fences', async () => {
    const f = fixture();
    const data = Buffer.from([0, 255, 128, 13, 10]);
    const file = await f.api.files.create({ file: await toFile(data, 'sample.bin'), purpose: 'user_data', expires_after: { anchor: 'created_at', seconds: 3600 } });
    parseAgentsContract('UploadedFile', file);
    expect(Buffer.from(await (await f.api.files.content(file.id)).arrayBuffer())).toEqual(data);
    expect((await f.api.files.list({ purpose: 'user_data' })).data).toHaveLength(1);
    expect((await f.api.files.list({ purpose: 'batch' })).data).toEqual([]);
    await expect(f.other.files.content(file.id)).rejects.toMatchObject({ status: 404 });
    await f.api.files.delete(file.id);
    await expect(f.api.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
  });

  it('versions skills, preserves archive paths, pins environment inputs, and prepares the workspace once', async () => {
    const f = fixture();
    const skill = await f.api.skills.create({ files: [await toFile(skillFile('report-reader'), 'report-reader/skill.md'), await toFile(Buffer.from('support'), 'report-reader/nested/read.txt')] });
    parseAgentsContract('Skill', skill);
    const uploaded = capabilityArchive([{ path: 'skill.zip', data: new Uint8Array(await (await f.api.skills.content.retrieve(skill.id)).arrayBuffer()) }], 'skill');
    expect(uploaded.files.map((file) => file.path)).toContain('nested/read.txt');
    const version = await f.api.skills.versions.create(skill.id, { files: await toFile(zipSync({ 'next/SKILL.md': skillFile('second-reader') }), 'next.zip') });
    parseAgentsContract('SkillVersion', version);
    expect((await f.api.skills.retrieve(skill.id)).default_version).toBe('1');
    const file = await f.api.files.create({ file: await toFile(Buffer.from('immutable input'), 'input.txt'), purpose: 'user_data' });
    const environment = await f.environments.prepare('alice', 'session', { type: 'openai_hosted', files: [{ type: 'file_id', file_id: file.id, path: '/workspace/input.txt' }], skills: [{ type: 'skill_reference', skill_id: skill.id }], network: { access: 'disabled' } });
    if (environment.type !== 'openai_hosted') throw new Error('Expected managed environment');
    expect(environment.skills[0]).toMatchObject({ version: '1', name: 'report-reader' });
    expect(environment.files[0]).toMatchObject({ file_id: file.id, size_bytes: 15 });
    const setup = await f.environments.managedLaunch('alice', environment.id);
    await f.api.skills.update(skill.id, { default_version: '2' });
    await f.api.files.delete(file.id);
    await f.api.skills.versions.delete('1', { skill_id: skill.id });
    const root = await mkdtemp(join(tmpdir(), 'rat-hosted-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const launch = { ...setup, sessionId: 'session', turnId: 'bootstrap', input: [], environment, agent: sessionAgent({ model: 'fixture' }, 'agent', 1) };
    const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'workspace-write', capabilities: { networkAccess: false } } }, workspace, 1000, { CODEX_AUTH_MODE: 'chatgpt' });
    try {
      const prepared = await prepareHostedEnvironment({ launch, workspace, plan, artifacts: f.artifacts, stateDirectory: join(root, 'host') });
      expect(prepared.environment).toMatchObject({ capability_directories: ['/workspace/.capabilities/skills/report-reader'] });
      expect(await readFile(join(workspace, 'input.txt'), 'utf8')).toBe('immutable input');
      expect(await readFile(join(workspace, '.capabilities/skills/report-reader/SKILL.md'), 'utf8')).toContain('report-reader');
      await writeFile(join(workspace, 'input.txt'), 'updated by the agent');
      await prepareHostedEnvironment({ launch, workspace, plan, artifacts: f.artifacts, stateDirectory: join(root, 'host'), previouslyPrepared: true });
      expect(await readFile(join(workspace, 'input.txt'), 'utf8')).toBe('updated by the agent');
    } finally { await rm(root, { recursive: true, force: true }); }
    await expect(f.other.skills.retrieve(skill.id)).rejects.toMatchObject({ status: 404 });
    await f.api.skills.delete(skill.id);
    await expect(f.api.skills.versions.list(skill.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects unsafe archive paths, duplicate skill entry points, reserved environment names, and network widening', async () => {
    const f = fixture();
    const bad = zipSync({ '../outside': Buffer.from('x'), 'safe/SKILL.md': skillFile('safe') });
    await expect(f.api.skills.create({ files: await toFile(bad, 'bad.zip') })).rejects.toMatchObject({ status: 400 });
    expect(() => capabilityArchive([{ path: 'SKILL.md', data: skillFile('safe') }, { path: 'sub/skill.md', data: skillFile('safe') }], 'skill')).toThrow('exactly one');
    await expect(f.environments.prepare('alice', 'session', { type: 'openai_hosted', env: { PATH: '/evil' } })).rejects.toMatchObject({ status: 400 });
    await expect(f.templates.create('alice', { network: { access: 'restricted', allowed_domains: ['*.example.com'] } })).rejects.toMatchObject({ status: 400 });
  });
});
