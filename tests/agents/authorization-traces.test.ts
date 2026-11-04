import { describe, expect, it } from 'vitest';
import { projectToolAuthorizationTrace } from '../../src/core/tool-authorization-traces.js';
import type { ToolAuthorizationReceipt } from '../../src/domain/tool-authorization.js';
import { exportAuthorizationTraces } from '../../src/trace-export.js';

const receipt: ToolAuthorizationReceipt = {
  id: 'authz_one', object: 'rat_things.tool_authorization', requestId: 'request_one', attempt: 1, at: 10,
  identity: { sessionId: 'sess_one', agentId: 'agent_one', runId: 'run_one', generation: 'generation_one', runtimeEpoch: 2,
    actor: { kind: 'human', id: 'PRIVATE_ACTOR', provider: 'slack' }, credentialSubject: { kind: 'actor', id: 'PRIVATE_SUBJECT' } },
  configuration: { subject: { kind: 'session', id: 'sess_one' }, revision: 1 },
  context: { kind: 'single_active_turn', turnId: 'turn_two' },
  policy: { serverLabel: 'work', destinationDigest: 'digest', allowedTools: ['PRIVATE_POLICY'] },
  policyDigest: 'policy_digest', toolName: 'lookup', credential: { kind: 'none' }, decision: 'allow',
  outcome: { kind: 'response_received', at: 12, httpStatus: 200, toolResult: 'unobserved' },
};

describe('authorization OTLP export', () => {
  it('uses stable owner-scoped identities and labels contextual Turns without inventing native parents', () => {
    const before = structuredClone(receipt);
    const trace = projectToolAuthorizationTrace('alice', receipt);
    const span = trace.otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(span).not.toHaveProperty('parentSpanId');
    expect(span.attributes).toContainEqual({ key: 'rat_things.context.turn_id', value: { stringValue: 'turn_two' } });
    expect(span.attributes).toContainEqual({ key: 'rat_things.attribution', value: { stringValue: 'single_active_turn' } });
    expect(span.status.code).toBe(0);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_');
    expect(projectToolAuthorizationTrace('alice', receipt)).toEqual(trace);
    expect(projectToolAuthorizationTrace('bob', receipt).otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId).not.toBe(span.traceId);
    expect(receipt).toEqual(before);
  });

  it('distinguishes denials, known tool errors and unobserved outcomes', () => {
    const span = (value: ToolAuthorizationReceipt) => projectToolAuthorizationTrace('alice', value).otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span({ ...receipt, decision: 'deny', reason: 'tool_not_admitted', outcome: { kind: 'not_dispatched', at: 10 } }).status.code).toBe(2);
    expect(span({ ...receipt, outcome: { kind: 'response_received', at: 11, httpStatus: 200, toolResult: 'error' } }).status.code).toBe(2);
    expect(span({ ...receipt, outcome: { kind: 'response_received', at: 11, httpStatus: 200, toolResult: 'success' } }).status.code).toBe(1);
    const unknown = span({ ...receipt, context: { kind: 'unresolved', reason: 'multiple_active_turns' }, outcome: { kind: 'unknown', reason: 'no_observation' } });
    expect(unknown.status.code).toBe(0);
    expect(unknown.startTimeUnixNano).toBe(unknown.endTimeUnixNano);
    expect(unknown.attributes.some(attribute => attribute.key === 'rat_things.context.turn_id')).toBe(false);
  });

  it('walks every authorization page and rejects a nonadvancing cursor', async () => {
    const first = projectToolAuthorizationTrace('alice', receipt);
    const second = projectToolAuthorizationTrace('alice', { ...receipt, id: 'authz_two', attempt: 2 });
    const queries: unknown[] = [];
    const exported = await exportAuthorizationTraces(async query => {
      queries.push(query);
      const data = query.after ? [second] : [first];
      return { object: 'list', data, has_more: !query.after, first_id: data[0]!.id, last_id: data[0]!.id };
    });
    expect(exported.resourceSpans).toHaveLength(2);
    expect(queries).toEqual([{ order: 'asc' }, { order: 'asc', after: 'authz_one' }]);
    await expect(exportAuthorizationTraces(async () => ({ object: 'list', data: [first], has_more: true, first_id: first.id, last_id: first.id }))).rejects.toThrow('did not advance');
  });
});
