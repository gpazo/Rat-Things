import type { RunStatus } from './contracts.js';

const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['dispatching', 'cancelled', 'failed'],
  dispatching: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['cancelling', 'cancelled', 'succeeded', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class InvalidStateTransitionError extends Error {
  public constructor(from: RunStatus, to: RunStatus) {
    super(`invalid run transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError(from, to);
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
