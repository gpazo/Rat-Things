import type { SessionTrace, TraceListParams } from './session-traces.js';
/**
 * The public contract belongs to OpenAI's Agents API. Import its published types
 * directly; runtime implementation records belong in ports, never in these DTOs.
 */
import type {
  Agent, AgentCreateParams, AgentUpdateParams, AgentListParams, AgentDeleted,
  AgentSession, AgentSessionDeleted, AgentSessionEvent, AgentSessionItem, Subagent,
} from 'openai/resources/beta/agents/agents';
import type {
  SessionCreateParams, SessionUpdateParams, SessionListParams,
} from 'openai/resources/beta/agents/sessions/sessions';
import type { EventCreateParams } from 'openai/resources/beta/agents/sessions/events';
import type { ItemListParams } from 'openai/resources/beta/agents/sessions/items';
import type { SubagentListParams } from 'openai/resources/beta/agents/sessions/subagents/subagents';
import type { Turn, TurnListParams } from 'openai/resources/beta/agents/sessions/turns';
import type {
  SessionArtifact, SessionArtifactDeleted, ArtifactListParams,
} from 'openai/resources/beta/agents/sessions/artifacts';
import type { EnvironmentInfo } from 'openai/resources/beta/agents/environments/environments';
import type { FileObject, FileDeleted, FileCreateParams as UploadedFileCreateParams, FileListParams as UploadedFileListParams } from 'openai/resources/files';
import type { Skill, DeletedSkill, SkillListParams, SkillUpdateParams } from 'openai/resources/skills/skills';
import type { SkillVersion, DeletedSkillVersion, VersionListParams } from 'openai/resources/skills/versions/versions';
import type {
  EnvironmentTemplate, EnvironmentTemplateDeleted, TemplateCreateParams,
  TemplateUpdateParams, TemplateListParams,
} from 'openai/resources/beta/agents/environments/templates';
import type {
  EnvironmentFile, FileCreateParams, FileListParams,
} from 'openai/resources/beta/agents/environments/files';
import type {
  Vault, VaultDeleted, VaultCreateParams, VaultListParams,
} from 'openai/resources/beta/agents/vaults/vaults';
import type {
  Credential, CredentialDeleted, CredentialCreateParams, CredentialUpdateParams,
  CredentialListParams,
} from 'openai/resources/beta/agents/vaults/credentials';

export type * from 'openai/resources/beta/agents/agents';
export type {
  SessionCreateParams, SessionUpdateParams, SessionListParams,
  Turn, TurnListParams, ItemListParams, SessionArtifact, SessionArtifactDeleted,
  EnvironmentInfo, EnvironmentTemplate, EnvironmentTemplateDeleted,
  TemplateCreateParams, TemplateUpdateParams, TemplateListParams,
  EnvironmentFile, FileCreateParams, FileListParams,
  Vault, VaultDeleted, VaultCreateParams, VaultListParams,
  Credential, CredentialDeleted, CredentialCreateParams, CredentialUpdateParams,
  CredentialListParams,
};

export type SessionEventsRequest = Pick<EventCreateParams, 'events'>;
export type CredentialRotateRequest = Omit<CredentialUpdateParams, 'vault_id'>;

/** Schema-generation roots. None of these types copy or rename upstream fields. */
export interface AgentsApiContracts {
  Trace: SessionTrace;
  TraceList: TraceListParams;
  UploadedFile: FileObject;
  UploadedFileDeleted: FileDeleted;
  UploadedFileCreate: Omit<UploadedFileCreateParams, 'file'>;
  UploadedFileList: { [Key in keyof UploadedFileListParams]: UploadedFileListParams[Key] };
  Skill: Skill;
  SkillDeleted: DeletedSkill;
  SkillVersion: SkillVersion;
  SkillVersionDeleted: DeletedSkillVersion;
  SkillList: SkillListParams;
  SkillVersionList: VersionListParams;
  SkillUpdate: SkillUpdateParams;
  Agent: Agent;
  AgentCreate: AgentCreateParams;
  AgentUpdate: AgentUpdateParams;
  AgentList: AgentListParams;
  AgentDeleted: AgentDeleted;
  Session: AgentSession;
  SessionCreate: SessionCreateParams;
  SessionUpdate: SessionUpdateParams;
  SessionList: SessionListParams;
  SessionDeleted: AgentSessionDeleted;
  SessionEvents: SessionEventsRequest;
  SessionEvent: AgentSessionEvent;
  Item: AgentSessionItem;
  ItemList: ItemListParams;
  Turn: Turn;
  TurnList: TurnListParams;
  Subagent: Subagent;
  SubagentList: SubagentListParams;
  Artifact: SessionArtifact;
  ArtifactDeleted: SessionArtifactDeleted;
  ArtifactList: ArtifactListParams;
  Environment: EnvironmentInfo;
  EnvironmentTemplate: EnvironmentTemplate;
  EnvironmentTemplateDeleted: EnvironmentTemplateDeleted;
  EnvironmentTemplateCreate: TemplateCreateParams;
  EnvironmentTemplateUpdate: TemplateUpdateParams;
  EnvironmentTemplateList: TemplateListParams;
  EnvironmentFile: EnvironmentFile;
  EnvironmentFileCreate: FileCreateParams;
  EnvironmentFileList: FileListParams;
  Vault: Vault;
  VaultDeleted: VaultDeleted;
  VaultCreate: VaultCreateParams;
  VaultList: VaultListParams;
  Credential: Credential;
  CredentialDeleted: CredentialDeleted;
  CredentialCreate: CredentialCreateParams;
  CredentialUpdate: CredentialRotateRequest;
  CredentialList: CredentialListParams;
}
