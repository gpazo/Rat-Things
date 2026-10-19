import type { InboxItem, LiveState, SubmissionId, SubmissionRecord, TaskId } from '@earendil-works/pi-durable';
import type { SessionRuntimeState } from '../../core/session-runtime-planning.js';
import type { PiCommand, PiLinks, PiTurnLink } from './protocol.js';

type TurnInputs = Pick<PiTurnLink, 'submissionId' | 'steerIds'>;
const belongsToTurn = (link: TurnInputs, id: number) => id === link.submissionId || Boolean(link.steerIds?.includes(id));

export function planSteerReceipt(previous: Readonly<PiCommand> | undefined, fingerprint: string): 'replayed' | 'new' {
  if (!previous) return 'new';
  if (previous.kind !== 'steer' || previous.fingerprint !== fingerprint) throw new Error('Pi operation ID already identifies a different command');
  return 'replayed';
}
export function planSteerTarget(link: TurnInputs, run: LiveState['run'], turnId: string, fingerprint: string):
  { kind: 'stale'; command: PiCommand } | { kind: 'admit'; command: PiCommand } {
  const command = { kind: 'steer' as const, turnId, fingerprint };
  return run?.inputs.some(id => belongsToTurn(link, id))
    ? { kind: 'admit', command: { ...command, status: 'accepted', taskId: run.taskId } }
    : { kind: 'stale', command: { ...command, status: 'stale' } };
}
export function planCancelReceipt(previous: Readonly<PiCommand> | undefined): 'finished' | 'pending' {
  return previous?.status === 'settled' || previous?.status === 'stale' ? 'finished' : 'pending';
}
export interface PiCancelPlan {
  cancelled: SubmissionId[];
  items: InboxItem[];
  command: PiCommand;
  target: TaskId | undefined;
}
export function planPiCancel(link: TurnInputs, run: LiveState['run'], previous: Readonly<PiCommand> | undefined, items: readonly InboxItem[], turnId: string): PiCancelPlan {
  const cancelled = items.filter(item => belongsToTurn(link, item.id)).map(item => item.id);
  const target = run?.inputs.some(id => belongsToTurn(link, id)) ? run.taskId : undefined;
  return { cancelled, items: items.filter(item => !cancelled.includes(item.id)), target,
    command: { kind: 'cancel', turnId, fingerprint: turnId, ...(target === undefined
      ? { status: previous || cancelled.length ? 'settled' : 'stale' }
      : { status: 'accepted', taskId: target }) } };
}

export function planPiRecoveryExhaustion(snapshot: SessionRuntimeState, inspection: { tasks: readonly { record: { id: TaskId } }[]; submissions: readonly Pick<SubmissionRecord, 'id' | 'status'>[] }) {
  return {
    affectedTurnIds: snapshot.turns.filter(binding => ['queued', 'in_progress', 'waiting'].includes(binding.turn.status)).map(binding => binding.turn.id),
    abortTaskIds: inspection.tasks.map(task => task.record.id),
    abortSubmissionIds: inspection.submissions.filter(submission => submission.status === 'queued').map(submission => submission.id),
  };
}
export function planPiRecoveryMarkers(links: PiLinks, timestamps: readonly { turnId: string; at: number }[]) {
  return {
    failures: timestamps.flatMap(({ turnId, at }) => links.turns[turnId]!.recoveryFailure ? [] : [{ turnId, failure: { message: 'Pi recovery attempts were exhausted.', at } }]),
    closingChildIds: Object.values(links.children).filter(child => child.closedAt === undefined).map(child => child.id),
  };
}
