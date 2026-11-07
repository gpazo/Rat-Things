import { expect, it } from 'vitest';
import { feedbackWindow, type SessionFeedback } from '../../src/core/session-feedback-planning.js';
import type { AgentResource } from '../../src/core/agents-ports.js';

const input = (id: string, acceptedAtMs: number): AgentResource<SessionFeedback> => ({ id, ownerId: 'owner', collection: 'feedback', revision: 1, createdAt: acceptedAtMs,
  value: { sessionId: 'sess_one', digest: id, events: [], actor: { id, kind: 'human' }, acceptedAtMs, turnId: `turn_${id}`, operationId: id,
    messages: [{ id: `msg_${id}`, role: 'user', content: [{ type: 'input_text', text: id }] }] } });

it('waits for quiet but never extends collection beyond one second from the oldest contribution', () => {
  const first = input('a', 1000);
  expect(feedbackWindow([first], 1100).waitMs).toBe(200);
  const near = input('b', 1250);
  expect(feedbackWindow([first, near], 1300).waitMs).toBe(250);
  const continuing = input('c', 1950);
  expect(feedbackWindow([first, near, continuing], 1990).waitMs).toBe(10);
  expect(feedbackWindow([first, near, continuing, input('next', 2050)], 2100).inputs.map(value => value.id)).toEqual(['a', 'b', 'c']);
});

it('bounds batch size, sorts ties deterministically, and lets cancellation force immediate collection', () => {
  const burst = Array.from({ length: 40 }, (_, index) => input(`user-${index}`, 1000));
  expect(feedbackWindow(burst, 1000).inputs).toHaveLength(32);
  expect(feedbackWindow(burst, 1000).waitMs).toBe(0);
  expect(feedbackWindow([input('b', 1000), input('a', 1000)], 1000, true)).toMatchObject({ waitMs: 0, inputs: [{ id: 'a' }, { id: 'b' }] });
  const huge = input('huge', 1000);
  huge.value.messages[0]!.content = [{ type: 'input_text', text: 'x'.repeat(300 * 1024) }];
  expect(feedbackWindow([huge, input('next', 1001)], 1000).inputs.map(value => value.id)).toEqual(['huge']);
});
