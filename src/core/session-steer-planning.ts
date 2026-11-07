import type { SessionState, SessionCommand } from './session-ports.js';
import { canonicalJson } from '../domain/json.js';
import { terminalTurn } from './session-planning.js';

export function planRejectedSteer(state: SessionState, receiptId: string, operationId: string,
  ids: { turnId: string; operationId: string }, now: number): SessionState {
  const receipt = state.receipts[receiptId];
  const command = receipt?.commands.find(command => command.type === 'steer' && command.operationId === operationId);
  if (!receipt || receipt.dispatched || command?.type !== 'steer') return state;
  const sourceIndex = state.turns.findIndex(binding => binding.turn.id === command.turnId);
  const source = state.turns[sourceIndex];
  if (!source) throw new Error('Rejected input has no source Turn');
  const orderedReceipts = Object.entries(state.receipts).sort((left, right) => (left[1].sequence ?? 0) - (right[1].sequence ?? 0));
  const previousCommands = orderedReceipts.slice(0, orderedReceipts.findIndex(([id]) => id === receiptId)).flatMap(([, previous]) => previous.dispatched ? previous.commands : []);
  // Dispatch reached this command only after preceding commands acknowledged.
  previousCommands.push(...receipt.commands.slice(0, receipt.commands.indexOf(command)));
  const started = new Set(previousCommands.filter(command => command.type === 'start').map(command => command.turnId));
  const afterIndex = Math.max(sourceIndex, ...previousCommands.filter(command => command.type === 'start' || command.type === 'steer').map(command => state.turns.findIndex(binding => binding.turn.id === command.turnId)));
  const successor = state.turns.slice(afterIndex).find(binding => binding !== source && started.has(binding.turn.id) && !terminalTurn(binding.turn) && !binding.cancelRequested
    && canonicalJson(binding.modelSettings) === canonicalJson(source.modelSettings) && canonicalJson(binding.configuration) === canonicalJson(source.configuration));
  const turnId = successor?.turn.id ?? ids.turnId;
  let afterItemId = successor?.input.at(-1)?.id ?? null;
  const input = command.input.map(message => { const moved = { ...message, afterItemId }; afterItemId = message.id; return moved; });
  const movedIds = new Set(input.map(message => message.id));
  const turns = state.turns.map(binding => binding === source ? { ...binding, input: binding.input.filter(message => !movedIds.has(message.id)),
    ...(binding.savedItems ? { savedItems: binding.savedItems.filter(item => !item.id || !movedIds.has(item.id)) } : {}),
  } : binding === successor ? { ...binding, input: [...binding.input, ...input] } : binding);
  if (!successor) turns.splice(afterIndex + 1, 0, { turn: { ...source.turn, id: turnId, status: 'queued', created_at: receipt.acceptedAt ?? now, started_at: null, completed_at: null, usage: null, error: null }, input,
    ...(source.configuration ? { configuration: source.configuration } : {}), ...(source.modelSettings ? { modelSettings: source.modelSettings } : {}),
  });
  const replacement: SessionCommand = successor ? { type: 'steer', turnId, input, operationId: ids.operationId } : { type: 'start', turnId, input };
  return { ...state, turns, session: { ...state.session, status: 'in_progress' }, receipts: { ...state.receipts,
    [receiptId]: { ...receipt, commands: receipt.commands.map(entry => entry === command ? replacement : entry) },
  } };
}
