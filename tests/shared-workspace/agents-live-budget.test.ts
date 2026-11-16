import { describe, expect, it } from 'vitest';
import { budgetDecision, type BudgetLimits, type BudgetObservation } from '../../testing/shared-workspace/agents-live/budget.js';

const limits: BudgetLimits = { maxTurns: 4, maxObservedTokens: 1_200_000, maxToolItems: 120, maxActiveMs: 35 * 60_000, reviewMs: 10 * 60_000 };
const observation = (overrides: Partial<BudgetObservation> = {}): BudgetObservation => ({
  phase: 'active', turns: 0, observedTokens: 0, toolItems: 0, activeElapsedMs: 0, reviewElapsedMs: 0, activeTurnIds: [], ...overrides,
});

describe('agents-live budget decision', () => {
  it('keeps usage below the inclusive thresholds in active mode', () => {
    expect(budgetDecision(limits, observation({ turns: 3, observedTokens: 1_199_999, toolItems: 119 }))).toEqual({
      action: 'continue', phase: 'active', denyInference: false, cancelTurnIds: [],
    });
  });

  it.each([
    ['token_limit', { observedTokens: 1_200_000 }],
    ['tool_limit', { toolItems: 120 }],
    ['active_time_limit', { activeElapsedMs: 35 * 60_000 }],
  ] as const)('enters review at the %s threshold and requests cancellation of active Turns', (reason, usage) => {
    expect(budgetDecision(limits, observation({ ...usage, activeTurnIds: ['turn-active'] }))).toEqual({
      action: 'enter_review', phase: 'review', denyInference: true, reason, cancelTurnIds: ['turn-active'],
    });
  });

  it('denies new Turns at the count limit without cancelling the last admitted Turn', () => {
    expect(budgetDecision(limits, observation({ turns: 4, activeTurnIds: ['last-admitted'] }))).toEqual({
      action: 'deny_inference', phase: 'active', denyInference: true, reason: 'turn_limit', cancelTurnIds: [],
    });
  });

  it('opens review after the final admitted Turn has finished', () => {
    expect(budgetDecision(limits, observation({ turns: 4 }))).toEqual({
      action: 'enter_review', phase: 'review', denyInference: true, reason: 'turn_limit', cancelTurnIds: [],
    });
  });

  it('does not treat pending or absent token usage as zero-threshold evidence', () => {
    const pending = observation({ activeTurnIds: ['pending-usage'] });
    delete pending.observedTokens;
    expect(budgetDecision(limits, pending)).toEqual({
      action: 'continue', phase: 'active', denyInference: false, cancelTurnIds: [],
    });
  });

  it('keeps review open until its deadline, then requests cleanup without another cancellation', () => {
    expect(budgetDecision(limits, observation({ phase: 'review', reviewElapsedMs: limits.reviewMs - 1, activeTurnIds: ['cancel-requested'] }))).toEqual({
      action: 'review', phase: 'review', denyInference: true, cancelTurnIds: [],
    });
    expect(budgetDecision(limits, observation({ phase: 'review', reviewElapsedMs: limits.reviewMs }))).toEqual({
      action: 'cleanup', phase: 'review', denyInference: true, reason: 'review_deadline', cancelTurnIds: [],
    });
  });
});
