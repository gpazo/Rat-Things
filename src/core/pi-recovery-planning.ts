export interface PiRecoveryFacts {
  closed: boolean;
  hasWork: boolean;
  worker: 'active' | 'stopped' | 'unknown' | 'absent';
  now: number;
  failures: readonly number[];
}
export type PiRecoveryDecision = { type: 'idle' } | { type: 'wait' } | { type: 'exhausted' } | { type: 'replace'; failures: number[]; delaySeconds: number };
export function planPiRecovery(facts: PiRecoveryFacts): PiRecoveryDecision {
  if (facts.closed || !facts.hasWork) return { type: 'idle' };
  if (facts.worker === 'active' || facts.worker === 'unknown') return { type: 'wait' };
  const failures = facts.failures.filter(time => time > facts.now - 600);
  if (failures.length >= 3) return { type: 'exhausted' };
  return { type: 'replace', failures: [...failures, facts.now], delaySeconds: facts.worker === 'absent' ? 0 : 2 ** failures.length };
}
