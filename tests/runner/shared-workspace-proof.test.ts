import { expect, it } from 'vitest';
import { acknowledgedFeedback } from '../../testing/shared-workspace/assertions.js';

it('accepts label capitalization while requiring every marker and the actual visual code', () => {
  const text = 'DESIGN-proof123 TEAM-3F1B. Engineer-proof123. QA-proof123.';
  expect(acknowledgedFeedback(text, 'proof123', 'TEAM-3F1B')).toBe(true);
  expect(acknowledgedFeedback(text, 'another-proof', 'TEAM-3F1B')).toBe(false);
  expect(acknowledgedFeedback(text, 'proof123', 'TEAM-WRONG')).toBe(false);
  expect(acknowledgedFeedback('DESIGN-proof123 TEAM-3F1B', 'proof123', 'TEAM-3F1B')).toBe(false);
});
