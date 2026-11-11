import type { SessionActor } from './session-caller.js';
import type { SessionState } from './session-ports.js';
import type { SessionStreamSnapshot } from './session-stream.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface SessionInputReceipt {
  id: string;
  actor: SessionActor;
  provenance?: import('./session-attribution.js').SessionInputProvenance;
  participant?: import('./session-collaboration-planning.js').Participant | undefined;
  reply?: import('./session-collaboration-planning.js').MessageReply | undefined;
  workspace?: import('./session-workspace-planning.js').WorkspaceFeedback | undefined;
  sequence: number;
  status: 'accepted' | 'dispatched' | 'failed';
  accepted_at: number;
  turn_ids: string[];
  message_ids: string[];
}
export interface SessionActivity extends Omit<SessionStreamSnapshot, 'eventRevision'> {
  cursor: string;
  inputs: SessionInputReceipt[];
  permissions?: string[];
  pending_inputs?: Array<{ receipt_id: string; messages: import('./session-ports.js').SessionMessage[] }>;
}
export interface SessionFollowOptions { after?: string; revalidate?: () => Promise<void> }
export const activityCursor = (id: string, revision: number) => `act_${id}_${revision}`;
export function activityRevision(id: string, cursor: string): number {
  const prefix = `act_${id}_`;
  const suffix = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : '';
  const revision = /^\d+(?:\.[a-f0-9]{16})?$/.test(suffix) ? suffix.split('.')[0]! : '';
  if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new AgentsApiError(400, 'Invalid activity cursor.', 'invalid_cursor');
  return Number(revision);
}
export function sessionInputs(state: SessionState): SessionInputReceipt[] {
  return [...state.archivedInputs ?? [], ...Object.entries(state.receipts).flatMap(([id, receipt]) => receipt.actor ? [{
    id, actor: receipt.actor, participant: receipt.participant, reply: receipt.reply, workspace: receipt.workspace, provenance: receipt.provenance ?? { kind: 'unknown' as const }, sequence: receipt.sequence ?? 0,
    status: receipt.failure ? 'failed' as const : receipt.dispatched ? 'dispatched' as const : 'accepted' as const,
    accepted_at: receipt.acceptedAt ?? state.session.created_at,
    turn_ids: receipt.turnIds ?? [...new Set(receipt.commands.map(command => command.turnId))],
    message_ids: receipt.messageIds ?? receipt.commands.flatMap(command => command.type === 'start' || command.type === 'steer' ? command.input.flatMap(message => 'id' in message ? [message.id as string] : []) : []),
  }] : [])].sort((a, b) => a.sequence - b.sequence);
}
export function sessionActivity(snapshot: SessionStreamSnapshot, revision: number, permissions?: string[]): SessionActivity {
  const { eventRevision: _revision, ...value } = snapshot;
  return { ...value, cursor: activityCursor(snapshot.session.id, revision), inputs: snapshot.inputs ?? [], ...(permissions ? { permissions } : {}) };
}
