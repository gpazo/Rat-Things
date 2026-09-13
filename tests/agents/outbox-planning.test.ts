import { describe, expect, it } from 'vitest';
import { agentsJobGroup, agentsStreamJobs, agentsJobRetrySeconds } from '../../src/core/agents-outbox-planning.js';

describe('Session work isolation', () => {
  it('retries a cold managed harness promptly without shortening unknown failure backoff', () => {
    expect(agentsJobRetrySeconds({ status: 503, code: 'service_unavailable' })).toBe(5);
    expect(agentsJobRetrySeconds({ status: 503, code: 'environment_unavailable' })).toBe(5);
    expect(agentsJobRetrySeconds({ status: 500, code: 'internal_error' })).toBeUndefined();
    expect(agentsJobRetrySeconds({ status: 408, code: 'environment_connection_timeout' })).toBeUndefined();
  });
  it('serializes integration input with execution while letting provider delivery retry independently', () => {
    const index = Object.freeze({ ownerId: 'owner', id: 'session', key: 'root', collection: 'session_integrations' });
    const [integration, delivery] = agentsStreamJobs(index);
    const [dispatch] = agentsStreamJobs({ ...index, collection: 'sessions' });
    const [snapshot] = agentsStreamJobs({ ...index, collection: 'session_runtime' });
    expect(agentsJobGroup(integration!)).toBe(agentsJobGroup(dispatch!));
    expect(agentsJobGroup(snapshot!)).toBe(agentsJobGroup(dispatch!));
    expect(agentsJobGroup(delivery!)).not.toBe(agentsJobGroup(dispatch!));
    expect(agentsJobGroup({ ...delivery!, ownerId: 'another' })).not.toBe(agentsJobGroup(delivery!));
  });
  it('ignores non-root or deleted resources and prepares completion only for terminal private executions', () => {
    const execution = { ownerId: 'owner', agentsSession: { sessionId: 'session', turnId: 'turn' } };
    expect(agentsStreamJobs({ ...execution, status: 'running' })).toEqual([]);
    expect(agentsStreamJobs({ ...execution, status: 'cancelled' })).toEqual([{ ownerId: 'owner', id: 'session', turnId: 'turn', type: 'complete' }]);
    expect(agentsStreamJobs({ ownerId: 'owner', id: 'session', key: 'root', collection: 'sessions', deleted: true })).toEqual([]);
    expect(agentsStreamJobs({ ownerId: 'owner', id: 'session', key: 'journal', collection: 'sessions' })).toEqual([]);
  });
});
