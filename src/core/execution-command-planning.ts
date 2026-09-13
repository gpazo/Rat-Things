import type { ExecutionReference } from '../domain/contracts.js';

export interface ExecutionCommandTarget { runId: string; execution: ExecutionReference }
export interface ExecutionCommandRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}
export type ExecutionCommand = {
  target: ExecutionCommandTarget;
  request: ExecutionCommandRequest;
  deadline: number;
} & ({ status: 'queued' } | { status: 'claimed' } | {
  status: 'completed'; response: { status: number; body: unknown };
} | { status: 'failed'; message: string });

export function commandCollection(runId: string): string { return `execution_commands_${runId}`; }
export function commandResponseCollection(runId: string): string { return `execution_responses_${runId}`; }

export function sameExecution(left: ExecutionCommandTarget, right: ExecutionCommandTarget): boolean {
  return left.runId === right.runId && left.execution.backend === right.execution.backend
    && left.execution.id === right.execution.id && Boolean(left.execution.generation)
    && left.execution.generation === right.execution.generation;
}

/** Only fixed root-supervised operations are admissible; callers never supply an origin. */
export function validExecutionCommand(target: ExecutionCommandTarget, request: ExecutionCommandRequest): boolean {
  const prefix = `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/`;
  if (!request.path.startsWith(prefix)) return false;
  const suffix = request.path.slice(prefix.length);
  if (request.method === 'GET') return suffix === 'health' || /^events\?after=\d+&limit=\d+$/.test(suffix);
  return ['environment-files', 'session-start', 'steer', 'interrupt'].includes(suffix)
    || /^requests\/[A-Za-z0-9_%.-]+\/respond$/.test(suffix);
}

export function claimCommand(command: ExecutionCommand, target: ExecutionCommandTarget, now: number):
  { kind: 'ignore' } | { kind: 'reject'; message: string } | { kind: 'execute'; command: ExecutionCommand } {
  if (command.status !== 'queued') return { kind: 'ignore' };
  if (!sameExecution(command.target, target)) return { kind: 'reject', message: 'Execution identity changed.' };
  if (command.deadline <= now) return { kind: 'reject', message: 'Execution command expired before acceptance.' };
  if (!validExecutionCommand(target, command.request)) return { kind: 'reject', message: 'Invalid execution command.' };
  return { kind: 'execute', command: { ...command, status: 'claimed' } };
}
