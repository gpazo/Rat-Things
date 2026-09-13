import type {
  AgentSession, AgentSessionItem, AgentSessionInputMessageParam, AgentSessionInputParam,
  AgentSessionEnvironmentState, AgentToolParam, Environment, EnvironmentParam, SessionArtifact, Subagent, TokenUsage, Turn,
} from '../domain/agents-api.js';
import type { ArtifactReference } from '../domain/contracts.js';

export type SessionMessage = AgentSessionInputMessageParam & { id: string; afterItemId?: string | null; acceptedOrdinal?: number };
export interface SavedSessionArtifact { artifact: SessionArtifact; content: ArtifactReference }
export interface SessionSubagentSnapshot { subagent: Subagent; turns: Turn[]; items: AgentSessionItem[]; artifacts?: SavedSessionArtifact[]; requiredActions?: AgentSession['required_actions'] }

/** Private bindings are implementation details, never part of a session response. */
export interface SessionTurnBinding {
  turn: Turn;
  input: SessionMessage[];
  cancelRequested?: boolean;
  savedItems?: AgentSessionItem[];
  savedArtifacts?: SavedSessionArtifact[];
}

export interface SessionState {
  session: AgentSession;
  turns: SessionTurnBinding[];
  receipts: Record<string, { digest: string; commands: SessionCommand[]; dispatched: boolean; failure?: { code: string; message: string } }>;
  deletedArtifacts: string[];
  subagents?: SessionSubagentSnapshot[];
}

export type SessionCommand =
  | { type: 'start'; turnId: string; input: SessionTurnBinding['input'] }
  | { type: 'steer'; turnId: string; input: AgentSessionInputMessageParam[]; operationId: string }
  | { type: 'cancel'; turnId: string }
  | { type: 'tool_result'; turnId: string; afterItemId?: string | null; acceptedOrdinal?: number; event: Extract<AgentSessionInputParam, { type: 'agent.session.input.tool_result' }> };

export interface SessionTurnObservation {
  turn: Turn;
  requiredActions: AgentSession['required_actions'];
}

/** All execution and environment effects live behind this port. */
export interface SessionExecution {
  initialize?(ownerId: string, session: AgentSession): Promise<void>;
  subagents?(ownerId: string, session: AgentSession): Promise<SessionSubagentSnapshot[]>;
  environment?(ownerId: string, session: AgentSession): Promise<AgentSessionEnvironmentState | undefined>;
  close?(ownerId: string, session: AgentSession): Promise<void>;
  checkInputConnection?(ownerId: string, session: AgentSession, turn: Turn): Promise<void>;
  prepare(ownerId: string, sessionId: string, environment: EnvironmentParam, agent: AgentSession['agent'], vaultIds: string[], tools?: AgentToolParam[], resumePreparation?: boolean): Promise<Environment>;
  start(ownerId: string, session: AgentSession, turn: SessionTurnBinding, history?: AgentSessionItem[]): Promise<void>;
  steer(ownerId: string, session: AgentSession, turnId: string, input: AgentSessionInputMessageParam[], operationId: string): Promise<void>;
  cancel(ownerId: string, session: AgentSession, turnId: string): Promise<void>;
  toolResult(ownerId: string, session: AgentSession, event: Extract<AgentSessionInputParam, { type: 'agent.session.input.tool_result' }>): Promise<void>;
  observe(ownerId: string, session: AgentSession, turn: Turn): Promise<SessionTurnObservation>;
  items(ownerId: string, session: AgentSession, turnId: string): Promise<AgentSessionItem[]>;
  artifacts(ownerId: string, session: AgentSession, turnId: string): Promise<SavedSessionArtifact[]>;
  artifactContent(ownerId: string, session: AgentSession, artifact: SavedSessionArtifact): Promise<ReadableStream<Uint8Array>>;
}

export interface SessionObservation {
  session: AgentSession;
  turns: SessionTurnObservation[];
}

export function totalUsage(usages: Array<TokenUsage | null>): TokenUsage | null {
  const available = usages.filter((usage): usage is TokenUsage => usage !== null);
  if (!available.length) return null;
  return available.reduce((total, usage) => ({
    input_tokens: total.input_tokens + usage.input_tokens,
    input_tokens_details: { cached_tokens: total.input_tokens_details.cached_tokens + usage.input_tokens_details.cached_tokens },
    output_tokens: total.output_tokens + usage.output_tokens,
    output_tokens_details: { reasoning_tokens: total.output_tokens_details.reasoning_tokens + usage.output_tokens_details.reasoning_tokens },
    total_tokens: total.total_tokens + usage.total_tokens,
  }), {
    input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0,
  });
}
