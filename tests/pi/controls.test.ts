import { describe, expect, it } from 'vitest';
import type { InboxItem, SubmissionId } from '@earendil-works/pi-durable';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import type { Turn } from '../../src/domain/agents-api.js';
import { asTaskId, json, type PiCommand, type PiLinks, type PiTurnLink } from '../../src/runner/pi/protocol.js';
import { planSteerReceipt, planSteerTarget, planCancelReceipt, planPiCancel, planPiRecoveryExhaustion, planPiRecoveryMarkers } from '../../src/runner/pi/controls.js';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen); }
  return value;
}
const id = (value: number) => value as SubmissionId;
const turn: Turn = { id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null, status: 'waiting', created_at: 1, started_at: 2, completed_at: null, usage: null, error: null };
const link: PiTurnLink = frozen({ turn: json(turn), conversationId: 1, submissionId: 2, requestId: 'turn:turn', steerIds: [3] });
const run = frozen({ taskId: asTaskId(9), inputs: [id(3)] });
const inbox: InboxItem[] = frozen([{ id: id(2), mode: 'steer', content: 'original' }, { id: id(3), mode: 'steer', content: 'steered' }, { id: id(4), mode: 'followUp', content: 'next Turn' }]);

describe('Pi control decisions', () => {
  it('checks replay identity separately from live targeting and preserves stale receipts', () => {
    const command: PiCommand = frozen({ kind: 'steer', turnId: 'turn', status: 'accepted', fingerprint: 'same', taskId: 9, submissionId: 3 });
    expect(planSteerReceipt(undefined, 'same')).toBe('new');
    expect(planSteerReceipt(command, 'same')).toBe('replayed');
    expect(() => planSteerReceipt(command, 'different')).toThrow('different command');
    expect(planSteerTarget(link, run, 'turn', 'same')).toEqual({ kind: 'admit', command: { kind: 'steer', turnId: 'turn', status: 'accepted', fingerprint: 'same', taskId: 9 } });
    expect(planSteerTarget(link, { taskId: asTaskId(10), inputs: [id(4)] }, 'turn', 'same')).toEqual({ kind: 'stale', command: { kind: 'steer', turnId: 'turn', status: 'stale', fingerprint: 'same' } });
    expect(link.steerIds).toEqual([3]);
  });

  it('settles matching queued inputs in order and targets the current generation of the same Turn', () => {
    expect(planCancelReceipt(undefined)).toBe('pending');
    expect(planCancelReceipt({ kind: 'cancel', turnId: 'turn', status: 'settled', fingerprint: 'turn' })).toBe('finished');
    const expected = { cancelled: [2, 3], items: [inbox[2]], target: 9, command: { kind: 'cancel', turnId: 'turn', fingerprint: 'turn', status: 'accepted', taskId: 9 } satisfies PiCommand };
    expect(planPiCancel(link, run, undefined, inbox, 'turn')).toEqual(expected);
    expect(planPiCancel(link, { ...run, taskId: asTaskId(10) }, expected.command, inbox, 'turn')).toEqual({ ...expected, target: 10, command: { ...expected.command, taskId: 10 } });
    expect(planPiCancel(link, { taskId: asTaskId(11), inputs: [id(4)] }, undefined, inbox, 'turn')).toEqual({ cancelled: [2, 3], items: [inbox[2]], target: undefined, command: { kind: 'cancel', turnId: 'turn', fingerprint: 'turn', status: 'settled' } });
    expect(inbox.map(item => item.id)).toEqual([2, 3, 4]);
  });

  it('distinguishes stale cancellation from settling a durable accepted receipt', () => {
    expect(planPiCancel(link, undefined, undefined, [], 'turn').command.status).toBe('stale');
    const accepted: PiCommand = { kind: 'cancel', turnId: 'turn', status: 'accepted', fingerprint: 'turn', taskId: 9 };
    expect(planPiCancel(link, undefined, accepted, [], 'turn').command.status).toBe('settled');
  });

  it('selects nonterminal Turns and retains native task and queued-submission cleanup order', () => {
    const snapshot = frozen({ ...initialSessionRuntime('session', 'agent', 'root'), turns: (['waiting', 'completed', 'queued', 'cancelled'] as const).map((status, index) => ({ threadId: 'root', nativeTurnId: String(index), items: [], turn: { ...turn, id: String(index), status } })) });
    const inspection = frozen({ tasks: [{ record: { id: asTaskId(9) } }, { record: { id: asTaskId(7) } }], submissions: [{ id: id(5), status: 'placed' as const }, { id: id(4), status: 'queued' as const }, { id: id(2), status: 'queued' as const }] });
    expect(planPiRecoveryExhaustion(snapshot, inspection)).toEqual({ affectedTurnIds: ['0', '2'], abortTaskIds: [9, 7], abortSubmissionIds: [4, 2] });
  });

  it('preserves existing failure markers and closed children with explicit millisecond timestamps', () => {
    const child = { id: 'open', conversationId: 5, keeperId: 6, spawnTaskId: 7, parentId: 'agent', parentTurnId: 'turn', name: 'worker', prompt: 'work', openedAt: 1, closing: false };
    const links: PiLinks = frozen({ sessionId: 'session', agentId: 'agent', rootId: 1, effects: [], inherited: [],
      turns: { turn: link, previous: { ...link, recoveryFailure: { message: 'previous failure', at: 0 } } }, children: { open: child, closed: { ...child, id: 'closed', closing: true, closedAt: 2 } } });
    expect(planPiRecoveryMarkers(links, [{ turnId: 'turn', at: 1234 }, { turnId: 'previous', at: 9999 }])).toEqual({ failures: [{ turnId: 'turn', failure: { message: 'Pi recovery attempts were exhausted.', at: 1234 } }], closingChildIds: ['open'] });
    expect(links.turns.previous?.recoveryFailure).toEqual({ message: 'previous failure', at: 0 });
    expect(links.children.open?.closing).toBe(false);
  });
});
