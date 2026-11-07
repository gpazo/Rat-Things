import { createHash } from 'node:crypto';
import type { AgentsStore, AgentObservation } from './agents-ports.js';
import type { FileService } from './file-service.js';
import type { SessionService } from './session-service.js';
import type { SessionState, SavedSessionArtifact } from './session-ports.js';
import { validateSessionCaller, type SessionCaller } from './session-caller.js';
import type { SessionShareManifest, ShareStageRequest, ShareStatus } from './session-share-types.js';
import { AgentsApiError, invalid, parseAgentsContract, resourceNotFound } from '../domain/agents-api-validation.js';
import { validateRuntimeAgent, CODEX_RUNTIME } from '../domain/session-runtime.js';
import { canonicalJson } from '../domain/json.js';
import { terminalTurn } from './session-planning.js';

interface StagedShare {
  request: ShareStageRequest;
  status: ShareStatus;
  evidence: unknown;
  artifacts: SavedSessionArtifact[];
}
export const shareDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const releaseDigest = (token: string) => createHash('sha256').update(token).digest('hex');

export class SessionShareService {
  public constructor(private readonly options: {
    store: AgentsStore;
    sessions: SessionService;
    files?: Pick<FileService, 'reference' | 'retrieve'>;
    admit: (ownerId: string, manifest: SessionShareManifest, caller?: SessionCaller) => Promise<{ observations?: AgentObservation[]; evidence: unknown }>;
  }) {}

  public async stage(ownerId: string, raw: unknown, caller?: SessionCaller): Promise<ShareStatus> {
    const request = parseShareStage(raw);
    const { manifest, digest } = request;
    const previous = await this.options.store.get<StagedShare>(ownerId, 'session_shares', manifest.operation_id);
    if (previous) {
      if (shareDigest(previous.value.request) !== shareDigest(request)) throw new AgentsApiError(409, 'Share operation content changed.', 'share_conflict');
      await validateSessionCaller(caller);
      return previous.value.status;
    }
    const session = await this.options.store.get<SessionState>(ownerId, 'sessions', manifest.session.id);
    if (session) throw new AgentsApiError(409, 'This Session identity already exists.', 'share_conflict');
    const admission = await this.options.admit(ownerId, manifest, caller);
    const artifacts: SavedSessionArtifact[] = [];
    for (const [index, id] of request.workspace_file_ids.entries()) {
      if (!this.options.files) throw new AgentsApiError(503, 'Share file storage is unavailable.', 'share_unavailable');
      const [file, reference] = await Promise.all([this.options.files.retrieve(ownerId, id), this.options.files.reference(ownerId, id)]);
      if (reference.sha256 !== manifest.workspace.parts[index]?.sha256 || file.bytes !== manifest.workspace.parts[index]?.bytes) invalid('Workspace part does not match the manifest');
    }
    for (const entry of manifest.artifacts) {
      if (!this.options.files) throw new AgentsApiError(503, 'Share artifact storage is unavailable.', 'share_unavailable');
      const content = await this.options.files.reference(ownerId, request.artifact_file_ids[entry.artifact.id]!);
      if (content.sha256 !== entry.sha256) invalid('Artifact does not match the manifest');
      artifacts.push({ artifact: entry.artifact, content });
    }
    const status: ShareStatus = { id: manifest.operation_id, session_id: manifest.session.id, digest, status: 'staged' };
    await validateSessionCaller(caller);
    await this.options.store.commit([{ resource: { ownerId, collection: 'session_shares', id: manifest.operation_id,
      createdAt: Math.floor(Date.now() / 1000), revision: 1, value: { request, status, evidence: admission.evidence, artifacts } satisfies StagedShare }, expectedRevision: 0 },
    { resource: { ownerId, collection: 'session_share_reservations', id: manifest.session.id, createdAt: Math.floor(Date.now() / 1000), revision: 1,
      value: { operationId: manifest.operation_id, digest } }, expectedRevision: 0 }], [...caller?.observations ?? [], ...admission.observations ?? []]);
    return status;
  }

  public async retrieve(ownerId: string, id: string): Promise<ShareStatus> {
    return (await this.required(ownerId, id)).value.status;
  }

  public async activate(ownerId: string, id: string, raw: unknown, caller?: SessionCaller): Promise<ShareStatus> {
    if (!record(raw) || Object.keys(raw).some(key => !['digest', 'release_token'].includes(key)) || typeof raw.digest !== 'string' || typeof raw.release_token !== 'string') invalid('Supply the Share digest and source release proof');
    let resource = await this.required(ownerId, id);
    if (resource.value.status.digest !== raw.digest || releaseDigest(raw.release_token as string) !== resource.value.request.manifest.release_hash) throw new AgentsApiError(409, 'Source release proof does not match this Share.', 'share_conflict');
    if (resource.value.status.status === 'active') { await validateSessionCaller(caller); return resource.value.status; }
    if (resource.value.status.status === 'staged') {
      await validateSessionCaller(caller);
      const accepted = { ...resource, revision: resource.revision + 1, value: { ...resource.value, status: { ...resource.value.status, status: 'activating' as const } } };
      await this.options.store.commit([{ resource: accepted, expectedRevision: resource.revision }], caller?.observations);
      resource = accepted;
    }
    await this.options.sessions.activateShare(ownerId, resource.value.request, resource.value.artifacts, resource.value.evidence);
    const current = await this.required(ownerId, id);
    if (current.value.status.status === 'active') return current.value.status;
    const status = { ...current.value.status, status: 'active' as const };
    await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, status } }, current.revision);
    return status;
  }

  private async required(ownerId: string, id: string) {
    return await this.options.store.get<StagedShare>(ownerId, 'session_shares', id) ?? resourceNotFound();
  }
}

export function parseShareStage(raw: unknown): ShareStageRequest {
  if (!record(raw) || Object.keys(raw).some(key => !['manifest', 'digest', 'workspace_file_ids', 'artifact_file_ids'].includes(key)) || !record(raw.manifest)
    || typeof raw.digest !== 'string' || !Array.isArray(raw.workspace_file_ids) || raw.workspace_file_ids.some(id => typeof id !== 'string') || !record(raw.artifact_file_ids)) invalid('Invalid Share stage request');
  const value = raw.manifest;
  if (Object.keys(value).some(key => !['version', 'operation_id', 'release_hash', 'session', 'source_agent', 'runtime', 'turns', 'subagents', 'imported_history', 'inputs', 'artifacts', 'deleted_artifacts', 'admission', 'environment', 'workspace'].includes(key))
    || value.version !== 1 || typeof value.operation_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operation_id)
    || typeof value.release_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.release_hash)
    || !record(value.runtime) || !['codex', 'pi'].includes(String(value.runtime.kind))
    || !Array.isArray(value.turns) || !Array.isArray(value.subagents) || !Array.isArray(value.imported_history) || !Array.isArray(value.inputs) || !Array.isArray(value.artifacts)
    || !Array.isArray(value.deleted_artifacts) || !record(value.admission) || !record(value.environment) || !record(value.workspace) || !Array.isArray(value.workspace.parts)) invalid('Invalid Share manifest');
  if (Buffer.byteLength(canonicalJson(value)) > 3 * 1024 * 1024) invalid('Share history exceeds 3 MiB');
  const session = parseAgentsContract('Session', value.session);
  if (value.runtime.kind === 'codex' && canonicalJson(value.runtime) !== canonicalJson(CODEX_RUNTIME)) invalid('Unsupported Codex runtime pin');
  validateRuntimeAgent(value.runtime as unknown as SessionShareManifest['runtime'], session.agent);
  if (session.status !== 'idle' || session.required_actions.length || session.vault_ids.length || session.environment.type === 'self_hosted') invalid('Share requires a completed boundary without source credentials');
  if (session.agent.tools.some(tool => !['function', 'web_search', 'programmatic_tool_calling'].includes(tool.type))) invalid('The destination cannot import credential-backed source tools');
  if (value.source_agent !== undefined) {
    const agent = parseAgentsContract('Agent', value.source_agent);
    if (agent.id !== session.agent.id || agent.tools.some(tool => !['function', 'web_search', 'programmatic_tool_calling', 'tool_search'].includes(tool.type))) invalid('Source Agent does not match this Session');
  }
  parseAgentsContract('SessionCreate', { agent: { model: session.agent.model }, environment: value.environment });
  if (value.environment.type !== session.environment.type || !['none', 'openai_hosted'].includes(String(value.environment.type))
    || ['env', 'setup_commands', 'files', 'environment_template_id'].some(key => key in (value.environment as Record<string, unknown>))) invalid('Share environments cannot contain source credentials or replay setup');
  for (const binding of value.turns) {
    if (!record(binding) || Object.keys(binding).some(key => !['turn', 'input', 'configuration', 'modelSettings', 'savedItems', 'savedTraceSteps'].includes(key)) || !Array.isArray(binding.input) || !Array.isArray(binding.savedItems)) invalid('Share requires materialized terminal Turns');
    const turn = parseAgentsContract('Turn', binding.turn);
    if (turn.session_id !== session.id || !terminalTurn(turn)) invalid('Share contains an active or unrelated Turn');
    for (const message of binding.input) {
      if (!record(message) || typeof message.id !== 'string') invalid('Invalid saved Session input');
      parseAgentsContract('SessionEvents', { events: [{ type: 'agent.session.input.message', input: [{ role: message.role, content: message.content }] }] });
    }
    for (const item of binding.savedItems) parseAgentsContract('Item', item);
  }
  for (const child of value.subagents) {
    if (!record(child) || Object.keys(child).some(key => !['subagent', 'turns', 'items', 'requiredActions', 'traceTurns'].includes(key)) || !Array.isArray(child.turns) || !Array.isArray(child.items)
      || child.requiredActions !== undefined && (!Array.isArray(child.requiredActions) || child.requiredActions.length)) invalid('Invalid Share subagent');
    const subagent = parseAgentsContract('Subagent', child.subagent);
    if (subagent.status !== 'closed') invalid('Share contains an active subagent');
    for (const rawTurn of child.turns) {
      const turn = parseAgentsContract('Turn', rawTurn);
      if (!terminalTurn(turn) || turn.session_id !== session.id) invalid('Share contains an active or unrelated subagent Turn');
    }
    for (const item of child.items) parseAgentsContract('Item', item);
  }
  for (const receipt of value.inputs) {
    if (!record(receipt) || !record(receipt.actor) || typeof receipt.actor.id !== 'string' || !['human', 'workload', 'operator', 'local'].includes(String(receipt.actor.kind))
      || !Number.isSafeInteger(receipt.sequence) || typeof receipt.sequence !== 'number' || receipt.sequence < 1 || !['dispatched', 'failed'].includes(String(receipt.status))
      || !Array.isArray(receipt.turn_ids) || !Array.isArray(receipt.message_ids) || typeof receipt.id !== 'string' || typeof receipt.accepted_at !== 'number') invalid('Share input receipt is not terminal');
  }
  for (const item of value.imported_history) parseAgentsContract('Item', item);
  for (const entry of value.artifacts) {
    if (!record(entry) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) invalid('Invalid Share artifact');
    const artifact = parseAgentsContract('Artifact', entry.artifact);
    if (typeof raw.artifact_file_ids[artifact.id] !== 'string') invalid('Share artifact content is missing');
  }
  for (const name of ['admitted', 'current']) {
    const evidence = value.admission[name];
    if (!record(evidence) || typeof evidence.digest !== 'string' || shareDigest(evidence.snapshot) !== evidence.digest) invalid('Invalid immutable admission evidence');
  }
  if (typeof value.workspace.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.workspace.sha256) || value.workspace.parts.length !== raw.workspace_file_ids.length
    || value.workspace.parts.length > 50 || session.environment.type === 'openai_hosted' && !value.workspace.parts.length) invalid('Invalid workspace manifest');
  for (const part of value.workspace.parts) if (!record(part) || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256) || typeof part.bytes !== 'number' || part.bytes < 0 || part.bytes > 3 * 1024 * 1024) invalid('Invalid workspace part');
  if (shareDigest(value) !== raw.digest) invalid('Share manifest digest does not match');
  return raw as unknown as ShareStageRequest;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
