export type BudgetPhase = 'active' | 'review';

export interface BudgetLimits {
  maxTurns: number;
  maxObservedTokens: number;
  maxToolItems: number;
  maxActiveMs: number;
  reviewMs: number;
}

export interface BudgetObservation {
  phase: BudgetPhase;
  turns: number;
  observedTokens?: number;
  toolItems?: number;
  activeElapsedMs: number;
  reviewElapsedMs: number;
  activeTurnIds: readonly string[];
}

export type BudgetDecision =
  | { action: 'continue'; phase: 'active'; denyInference: false; cancelTurnIds: readonly [] }
  | { action: 'deny_inference'; phase: 'active'; denyInference: true; reason: 'turn_limit'; cancelTurnIds: readonly [] }
  | { action: 'enter_review'; phase: 'review'; denyInference: true; reason: 'turn_limit' | 'token_limit' | 'tool_limit' | 'active_time_limit'; cancelTurnIds: readonly string[] }
  | { action: 'review'; phase: 'review'; denyInference: true; cancelTurnIds: readonly [] }
  | { action: 'cleanup'; phase: 'review'; denyInference: true; reason: 'review_deadline'; cancelTurnIds: readonly [] };

/** Decide admission, cancellation and review timing from a plain usage snapshot. */
export function budgetDecision(limits: BudgetLimits, observed: BudgetObservation): BudgetDecision {
  if (observed.phase === 'review') {
    return observed.reviewElapsedMs >= limits.reviewMs
      ? { action: 'cleanup', phase: 'review', denyInference: true, reason: 'review_deadline', cancelTurnIds: [] }
      : { action: 'review', phase: 'review', denyInference: true, cancelTurnIds: [] };
  }

  const reason = observed.observedTokens !== undefined && observed.observedTokens >= limits.maxObservedTokens
    ? 'token_limit'
    : observed.toolItems !== undefined && observed.toolItems >= limits.maxToolItems
      ? 'tool_limit'
      : observed.activeElapsedMs >= limits.maxActiveMs
        ? 'active_time_limit'
        : undefined;
  return reason
    ? { action: 'enter_review', phase: 'review', denyInference: true, reason, cancelTurnIds: [...observed.activeTurnIds] }
    // Reaching the Turn count closes admission only. The last admitted Turn is allowed to finish.
    : observed.turns >= limits.maxTurns
      ? observed.activeTurnIds.length === 0
        ? { action: 'enter_review', phase: 'review', denyInference: true, reason: 'turn_limit', cancelTurnIds: [] }
        : { action: 'deny_inference', phase: 'active', denyInference: true, reason: 'turn_limit', cancelTurnIds: [] }
      : { action: 'continue', phase: 'active', denyInference: false, cancelTurnIds: [] };
}
