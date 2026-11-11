import type { SessionInputReceipt } from './session-activity.js';
import type { SessionMessage } from './session-ports.js';

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

export function participantContext(message: SessionMessage): string {
  const identity = JSON.stringify({ id: message.actor?.id, kind: message.actor?.kind });
  return message.provenance?.kind === 'authenticated' ? `[Authenticated participant ${identity}]`
    : message.provenance?.kind === 'imported' ? `[Reported source participant ${identity}; imported history, identity not verified]`
      : `[Reported participant ${identity}; identity not verified]`;
}
