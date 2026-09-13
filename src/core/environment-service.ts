import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentSessionEnvironmentState, Environment, EnvironmentInfo, EnvironmentParam } from '../domain/agents-api.js';
import { AgentsApiError, parseAgentsContract, resourceNotFound } from '../domain/agents-api-validation.js';
import { absolutePath, workspacePath, decodeBase64 } from '../domain/environment-planning.js';
import { environmentDirectory, environmentFilePage } from '../domain/environment-files.js';
import type { EnvironmentFileOperations } from './environment-file-ports.js';
import { environmentTokenIdentity, type EnvironmentCredentialStore, type EnvironmentIdentity } from '../credentials/environment.js';
import type { AgentResource, AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';
import type { EnvironmentTemplateService } from './environment-template-service.js';
import { publicTemplate, type HostedEnvironmentConfiguration } from '../domain/environment-planning.js';
import type { FileService } from './file-service.js';
import type { SkillService } from './skill-service.js';
import type { SessionLaunch } from '../domain/session-execution.js';

export interface StoredEnvironment {
  environment: Exclude<Environment, { type: 'none' }>;
  sessionId: string;
  credentialReference?: string;
  configuration?: HostedEnvironmentConfiguration;
  hostedFiles?: SessionLaunch['hostedFiles'];
  hostedSkills?: SessionLaunch['hostedSkills'];
  runId?: string;
  status: EnvironmentInfo['status'];
  registrationId?: string;
  connectedUntil?: number;
  connectedAt?: number;
  retired?: boolean;
}

export class EnvironmentService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;
  public constructor(private readonly options: { store: AgentsStore; credentials: EnvironmentCredentialStore; fileOperations?: EnvironmentFileOperations; fileContent?: (ownerId: string, fileId: string) => Promise<Uint8Array>; relayURL?: string; clock?: AgentsClock; ids?: AgentsIds;
    templates?: Pick<EnvironmentTemplateService, 'resolve'>;
    uploadedFiles?: Pick<FileService, 'reference' | 'retrieve'>;
    skills?: Pick<SkillService, 'reference'>;
    managedFiles?: (ownerId: string, sessionId: string, operation: import('./environment-file-ports.js').EnvironmentFileOperation) => Promise<unknown>;
  }) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
    if (options.relayURL && new URL(options.relayURL).protocol !== 'https:') throw new Error('Environment relay URL must use HTTPS');
  }

  public async prepare(ownerId: string, sessionId: string, input: EnvironmentParam, resumePreparation = false): Promise<Environment> {
    if (input.type === 'none') return input;
    const environmentId = resumePreparation ? `env_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}` : this.ids.next('env');
    const previous = resumePreparation ? await this.options.store.get<StoredEnvironment>(ownerId, 'environments', environmentId) : undefined;
    if (previous) return previous.value.environment;
    if (input.type === 'openai_hosted') {
      if (!this.options.templates || !this.options.managedFiles) throw new AgentsApiError(503, 'Managed environment execution is not configured.', 'environment_unavailable', 'environment');
      const { type: _type, environment_template_id, ...inline } = input;
      const configuration = await this.options.templates.resolve(ownerId, environment_template_id, inline);
      const id = environmentId;
      const now = this.clock.now();
      const { name: _name, object: _object, created_at: _created, updated_at: _updated, ...settings } = publicTemplate(configuration, { id, created_at: now, updated_at: now });
      const preparedFiles = await Promise.all((configuration.files ?? []).map(async (file) => {
        const identity = { id: this.ids.next('envfile'), path: file.path };
        if (file.type === 'inline') return { file: { ...identity, type: file.type, size_bytes: decodeBase64(file.data, 'files.data').byteLength } };
        const saved = this.options.uploadedFiles ? await this.options.uploadedFiles.retrieve(ownerId, file.file_id) : resourceNotFound();
        if (saved.bytes > 50 * 1024 * 1024) throw new AgentsApiError(400, 'Environment input files must not exceed 50 MiB.', 'invalid_request', 'environment.files');
        return { file: { ...identity, type: file.type, file_id: file.file_id, size_bytes: saved.bytes }, launch: { path: file.path, content: await this.options.uploadedFiles!.reference(ownerId, file.file_id) } };
      }));
      const preparedSkills = await Promise.all((configuration.skills ?? []).map(async (skill) => {
        if (skill.type === 'inline') return { skill: { type: skill.type, name: skill.name, description: skill.description } };
        const saved = this.options.skills ? await this.options.skills.reference(ownerId, skill.skill_id, skill.version) : resourceNotFound();
        return { skill: { type: skill.type, skill_id: skill.skill_id, name: saved.version.name, description: saved.version.description, version: saved.version.version }, launch: { name: saved.version.name, description: saved.version.description, content: saved.content } };
      }));
      const files = preparedFiles.map((entry) => entry.file);
      const hostedFiles = preparedFiles.flatMap((entry) => entry.launch ? [entry.launch] : []);
      const skills = preparedSkills.map((entry) => entry.skill);
      const hostedSkills = preparedSkills.flatMap((entry) => entry.launch ? [entry.launch] : []);
      const environment: Extract<Environment, { type: 'openai_hosted' }> = { ...settings, type: 'openai_hosted', files, skills };
      await this.options.store.put<StoredEnvironment>({ id, ownerId, collection: 'environments', createdAt: now, revision: 1, value: { environment, sessionId, configuration, hostedFiles, hostedSkills, status: 'pending' } }, 0);
      return environment;
    }
    if (!this.options.relayURL) throw new AgentsApiError(503, 'The environment relay is not configured.', 'environment_unavailable', 'environment');
    absolutePath(input.workspace_directory, 'environment.workspace_directory');
    (input.capability_directories ?? []).forEach((path) => absolutePath(path, 'environment.capability_directories'));
    const id = environmentId;
    const environment: Environment = { id, type: 'self_hosted', workspace_directory: input.workspace_directory, capability_directories: input.capability_directories ?? [], remote_url: this.options.relayURL.replace(/\/$/, '') };
    const credentialReference = await this.options.credentials.create(ownerId, id);
    await this.options.store.put<StoredEnvironment>({ id, ownerId, collection: 'environments', createdAt: this.clock.now(), revision: 1, value: { environment, sessionId, credentialReference, status: 'pending' } }, 0);
    return environment;
  }

  public async retrieve(ownerId: string, id: string): Promise<EnvironmentInfo> {
    const { value } = await this.required(ownerId, id);
    const environment = value.environment;
    return { id, object: 'agent.environment', type: environment.type, status: this.status(value), files: environment.type === 'openai_hosted' ? environment.files : [], plugins: environment.type === 'openai_hosted' ? environment.plugins : [], skills: environment.type === 'openai_hosted' ? environment.skills : [] };
  }

  public async state(ownerId: string, id: string): Promise<AgentSessionEnvironmentState> {
    const info = await this.retrieve(ownerId, id);
    return { id, type: info.type, status: info.status === 'expired' ? 'failed' : info.status, error: info.status === 'expired' || info.status === 'failed' ? { code: 'environment_unavailable', type: 'server_error', message: 'The environment is unavailable.' } : null };
  }

  public async files(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('EnvironmentFileList', raw);
    const value = await this.fileEnvironment(ownerId, id);
    const entries = await this.executeFiles(ownerId, value, { operation: 'list', path: environmentDirectory(query.path ?? '/workspace') });
    if (!Array.isArray(entries)) throw new Error('Environment file list is invalid');
    const files = entries.map((entry: unknown) => parseAgentsContract('EnvironmentFile', { ...(typeof entry === 'object' && entry !== null ? entry : {}), object: 'agent.environment.file', environment_id: id }));
    return environmentFilePage(files, ownerId, id, query);
  }

  public async createFile(ownerId: string, id: string, raw: unknown) {
    const input = parseAgentsContract('EnvironmentFileCreate', raw);
    workspacePath(input.path, 'path');
    const value = await this.fileEnvironment(ownerId, id);
    const data = input.type === 'inline' ? decodeBase64(input.data, 'data') : this.options.fileContent ? await this.options.fileContent(ownerId, input.file_id) : resourceNotFound();
    const limit = (input.type === 'inline' ? 5 : 50) * 1024 * 1024;
    if (data.byteLength > limit) throw new AgentsApiError(413, 'File exceeds the environment upload limit.', 'invalid_request', input.type === 'inline' ? 'data' : 'file_id');
    const chunkSize = 1024 * 1024;
    let result: unknown;
    if (data.byteLength <= chunkSize) result = await this.executeFiles(ownerId, value, { operation: 'write', path: input.path, data: Buffer.from(data).toString('base64') });
    else {
      const uploadId = randomUUID();
      const sha256 = createHash('sha256').update(data).digest('hex');
      try {
        for (let offset = 0; offset < data.byteLength; offset += chunkSize) result = await this.executeFiles(ownerId, value, {
          operation: 'write_chunk', path: input.path, uploadId, offset, size: data.byteLength, sha256, data: Buffer.from(data.subarray(offset, offset + chunkSize)).toString('base64'),
        });
      } catch (error) {
        await this.executeFiles(ownerId, value, { operation: 'write_abort', path: input.path, uploadId }).catch(() => {});
        throw error;
      }
    }
    return parseAgentsContract('EnvironmentFile', { ...(typeof result === 'object' && result !== null ? result : {}), object: 'agent.environment.file', environment_id: id });
  }

  /** Private execution coordinates are derived from the owned environment, never an HTTP body. */
  public async workspaceDirectory(ownerId: string, id: string): Promise<string> {
    const { environment } = (await this.required(ownerId, id)).value;
    return environment.type === 'self_hosted' ? environment.workspace_directory : '/workspace';
  }

  private async fileEnvironment(ownerId: string, id: string) {
    const { value } = await this.required(ownerId, id);
    if (value.retired) resourceNotFound();
    if (this.status(value) !== 'connected') throw new AgentsApiError(503, 'The environment must be connected for file operations.', 'environment_unavailable');
    return value;
  }

  private executeFiles(ownerId: string, value: StoredEnvironment, operation: import('./environment-file-ports.js').EnvironmentFileOperation) {
    if (value.environment.type === 'openai_hosted' && this.options.managedFiles) return this.options.managedFiles(ownerId, value.sessionId, operation);
    if (value.credentialReference && this.options.fileOperations) return this.options.fileOperations.execute(value.environment.id, value.credentialReference, operation);
    throw new AgentsApiError(503, 'Environment files are unavailable.', 'environment_unavailable');
  }

  public async managedLaunch(ownerId: string, id: string): Promise<Pick<SessionLaunch, 'hostedConfiguration' | 'hostedFiles' | 'hostedSkills'>> {
    const { value } = await this.required(ownerId, id);
    if (value.environment.type !== 'openai_hosted' || !value.configuration || value.retired) resourceNotFound();
    if (value.status === 'failed' || value.status === 'expired') throw new AgentsApiError(409, 'The managed environment is unavailable. Create a new session.', 'environment_unavailable');
    return { hostedConfiguration: value.configuration, hostedFiles: value.hostedFiles ?? [], hostedSkills: value.hostedSkills ?? [] };
  }

  public async attachManaged(ownerId: string, id: string, runId: string): Promise<void> {
    await this.update(ownerId, id, (value) => {
      if (value.environment.type !== 'openai_hosted' || value.retired) resourceNotFound();
      if (value.status === 'failed' || value.status === 'expired') throw new AgentsApiError(409, 'The managed environment is unavailable. Create a new session.', 'environment_unavailable');
      return { ...value, runId, status: 'pending' };
    });
  }

  public async managedStatus(ownerId: string, id: string, runId: string, status: 'connected' | 'failed' | 'expired'): Promise<void> {
    await this.update(ownerId, id, (value) => {
      if (value.retired || value.runId !== runId || value.environment.type !== 'openai_hosted') throw new Error('Managed environment execution authority changed');
      return { ...value, status, connectedUntil: status === 'connected' ? this.clock.now() + 45 : 0 };
    });
  }

  /** The authenticated application obtains only the restricted executor key. */
  public async executorConnection(ownerId: string, id: string) {
    const { value } = await this.required(ownerId, id);
    if (value.retired || !value.credentialReference || value.environment.type !== 'self_hosted') resourceNotFound();
    const credentials = await this.options.credentials.read(value.credentialReference);
    return { environment_id: id, remote_url: this.options.relayURL!, executor_key: credentials.executor };
  }

  public async launchReference(ownerId: string, id: string, connectionDeadline?: number): Promise<string> {
    const { value } = await this.required(ownerId, id);
    if (value.retired || !value.credentialReference) resourceNotFound();
    if (connectionDeadline !== undefined && ((value.connectedAt ?? 0) > connectionDeadline || this.status(value) !== 'connected' && this.clock.now() >= connectionDeadline)) throw new AgentsApiError(408, 'The execution environment did not connect within five minutes.', 'environment_connection_timeout');
    if (this.status(value) !== 'connected') throw new AgentsApiError(503, 'Waiting for the execution environment to connect.', 'environment_unavailable');
    return value.credentialReference;
  }

  public async authenticate(token: string, environmentId: string, role: EnvironmentIdentity['role']): Promise<EnvironmentIdentity> {
    const identity = environmentTokenIdentity(token);
    if (!identity || identity.environmentId !== environmentId || identity.role !== role) unauthorized();
    const resource = await this.options.store.get<StoredEnvironment>(identity.ownerId, 'environments', environmentId);
    if (!resource || resource.value.retired || !resource.value.credentialReference) unauthorized();
    const credentials = await this.options.credentials.read(resource.value.credentialReference);
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(token), digest(credentials[role]))) unauthorized();
    return identity;
  }

  /** A lease makes process death visible even when a disconnect notification cannot be written. */
  public async connection(identity: EnvironmentIdentity, registrationId: string, connected: boolean): Promise<void> {
    await this.update(identity.ownerId, identity.environmentId, (value) => {
      if (value.retired) resourceNotFound();
      if (!connected && value.registrationId !== registrationId) return value;
      return { ...value, registrationId, status: connected ? 'connected' : 'disconnected', connectedUntil: connected ? this.clock.now() + 45 : 0,
        ...(connected ? { connectedAt: value.registrationId === registrationId && value.connectedAt !== undefined ? value.connectedAt : this.clock.now() } : {}),
      };
    });
  }

  public async retire(ownerId: string, id: string): Promise<void> {
    const { value } = await this.required(ownerId, id);
    if (!value.retired) await this.update(ownerId, id, (value) => ({ ...value, retired: true, status: 'expired' }));
    if (value.credentialReference) await this.options.credentials.revoke(value.credentialReference);
  }

  /** Private routing metadata for durable connection wake-ups. */
  public async sessionId(ownerId: string, id: string): Promise<string | undefined> {
    const resource = await this.options.store.get<StoredEnvironment>(ownerId, 'environments', id);
    return resource && !resource.value.retired ? resource.value.sessionId : undefined;
  }

  private status(value: StoredEnvironment): EnvironmentInfo['status'] {
    return value.retired ? 'expired' : value.status === 'connected' && (value.connectedUntil ?? 0) <= this.clock.now() ? 'disconnected' : value.status;
  }
  private async required(ownerId: string, id: string) {
    const resource = await this.options.store.get<StoredEnvironment>(ownerId, 'environments', id) ?? resourceNotFound();
    return resource;
  }
  private async update(ownerId: string, id: string, change: (value: StoredEnvironment) => StoredEnvironment) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const resource = await this.required(ownerId, id);
      const updated: AgentResource<StoredEnvironment> = { ...resource, revision: resource.revision + 1, value: change(resource.value) };
      try { await this.options.store.put(updated, resource.revision); return; }
      catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 4) throw error; }
    }
  }
}

function unauthorized(): never { throw new AgentsApiError(401, 'Invalid environment connection key.', 'invalid_api_key'); }
