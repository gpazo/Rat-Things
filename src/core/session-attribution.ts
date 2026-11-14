import { sessionInputs, type SessionInputReceipt } from './session-activity.js';
import type { SessionMessage, SessionState } from './session-ports.js';

export type SessionInputProvenance =
  | { kind: 'authenticated' }
  | { kind: 'unknown' }
  | { kind: 'imported'; operation_id: string; source_receipt_id?: string; source_sequence?: number };

export function importedSessionMessage(message: SessionMessage, operationId: string): SessionMessage {
  return { ...message, ...(message.reply ? { reply: { ...message.reply, provenance: { kind: 'imported' as const, operation_id: operationId } } } : {}), provenance: { kind: 'imported', operation_id: operationId } };
}

export function importedSessionReceipts(inputs: SessionInputReceipt[], operationId: string): SessionInputReceipt[] {
  return inputs.map((input, index) => ({ ...input,
    id: `imported_${operationId}_${index + 1}`,
    ...(input.reply ? { reply: { ...input.reply, provenance: { kind: 'imported' as const, operation_id: operationId } } } : {}),
    sequence: index + 1,
    provenance: { kind: 'imported', operation_id: operationId, source_receipt_id: input.id, source_sequence: input.sequence },
  }));
}

export function sharedSessionReceipts(state: SessionState): SessionInputReceipt[] {
  const attributed = sessionInputs(state);
  const unattributed: SessionInputReceipt[] = Object.entries(state.receipts).flatMap(([id, receipt]) => {
    if (receipt.actor) return [];
    const messages = receipt.commands.flatMap(command => command.type === 'start' || command.type === 'steer' ? command.input : []);
    if (!messages.length) return [];
    return [{ id, actor: { id: 'unattributed', kind: 'operator', label: 'Unattributed input' }, provenance: { kind: 'unknown' },
      sequence: receipt.sequence ?? 0, accepted_at: receipt.acceptedAt ?? state.session.created_at,
      status: receipt.failure ? 'failed' : receipt.dispatched ? 'dispatched' : 'accepted',
      message_ids: messages.map(message => message.id), turn_ids: [...new Set(receipt.commands.map(command => command.turnId))],
      ...(receipt.workspace ? { workspace: receipt.workspace } : {}), ...(receipt.reply ? { reply: receipt.reply } : {}),
    }];
  });
  return [...attributed, ...unattributed].sort((a, b) => a.sequence - b.sequence).map((receipt, index) => ({ ...receipt, sequence: index + 1 }));
}

export function participantContext(message: SessionMessage): string {
  const identity = JSON.stringify({ id: message.actor?.id, kind: message.actor?.kind });
  return message.provenance?.kind === 'authenticated' ? `[Authenticated participant ${identity}]`
    : message.provenance?.kind === 'imported' ? `[Reported source participant ${identity}; imported history, identity not verified]`
      : `[Reported participant ${identity}; identity not verified]`;
}
