import { describe, expect, it } from 'vitest';

import { RUN_STATUSES, type RunStatus } from '../../src/domain/contracts.js';
import {
  assertTransition,
  canTransition,
  InvalidStateTransitionError,
  isTerminal,
} from '../../src/domain/state.js';

const allowed: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['dispatching', 'cancelled', 'failed'],
  dispatching: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['cancelling', 'cancelled', 'succeeded', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

describe('run state transitions', () => {
  it('matches the complete transition matrix', () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed[from].includes(to));
      }
    }
  });

  it('asserts valid transitions and describes invalid transitions', () => {
    expect(() => assertTransition('queued', 'dispatching')).not.toThrow();
    expect(() => assertTransition('running', 'succeeded')).not.toThrow();

    let error: unknown;
    try {
      assertTransition('succeeded', 'running');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidStateTransitionError);
    expect(error).toMatchObject({
      name: 'InvalidStateTransitionError',
      message: 'invalid run transition: succeeded -> running',
    });
  });

  it('identifies only final statuses as terminal', () => {
    expect(RUN_STATUSES.filter(isTerminal)).toEqual(['succeeded', 'failed', 'cancelled']);
  });
});
