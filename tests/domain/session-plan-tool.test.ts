import { expect, it } from 'vitest';
import { SESSION_PLAN_TOOL } from '../../src/domain/session-plan.js';

it('guides independent Plan items, stable IDs, and verification-specific unresolved states', () => {
  const { description, parameters } = SESSION_PLAN_TOOL;
  expect(description).toMatch(/complete ordered Plan/);
  expect(description).toMatch(/each independently actionable request, feedback item, and verification check as its own item/);
  expect(description).toMatch(/preserve its id/);
  expect(description).toMatch(/Keep unresolved checks in next, working, deferred, reopened, or needs_discussion/);
  expect(description).toMatch(/Mark an item addressed only after that specific item is verified/);
  expect(parameters.properties.items.items.properties.text.description).toMatch(/Split independent requirements into separate items/);
  expect(parameters.properties.items.items.properties.state.description).toMatch(/Use next or working while work or verification remains/);
});
