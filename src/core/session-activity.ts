import type { SessionActor } from './session-caller.js';
import type { SessionState } from './session-ports.js';
import type { SessionStreamSnapshot } from './session-stream.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface SessionInputReceipt {
  id: string;
  actor: SessionActor;
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
}
export interface SessionFollowOptions { after?: string; revalidate?: () => Promise<void> }
export const activityCursor = (id: string, revision: number) => `act_${id}_${revision}`;
export function activityRevision(id: string, cursor: string): number {
  const prefix = `act_${id}_`;
  const revision = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : '';
  if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new AgentsApiError(400, 'Invalid activity cursor.', 'invalid_cursor');
  return Number(revision);
}
export function sessionInputs(state: SessionState): SessionInputReceipt[] {
  return [...state.archivedInputs ?? [], ...Object.entries(state.receipts).flatMap(([id, receipt]) => receipt.actor ? [{
    id, actor: receipt.actor, sequence: receipt.sequence ?? 0,
    status: receipt.failure ? 'failed' as const : receipt.dispatched ? 'dispatched' as const : 'accepted' as const,
    accepted_at: receipt.acceptedAt ?? state.session.created_at,
    turn_ids: [...new Set(receipt.commands.map(command => command.turnId))],
    message_ids: receipt.commands.flatMap(command => command.type === 'start' || command.type === 'steer' ? command.input.flatMap(message => 'id' in message ? [message.id as string] : []) : []),
  }] : [])].sort((a, b) => a.sequence - b.sequence);
}
export function sessionActivity(snapshot: SessionStreamSnapshot, revision: number, permissions?: string[]): SessionActivity {
  const { eventRevision: _revision, ...value } = snapshot;
  return { ...value, cursor: activityCursor(snapshot.session.id, revision), inputs: snapshot.inputs ?? [], ...(permissions ? { permissions } : {}) };
}
