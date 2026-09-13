import { vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionIntegrationService } from '../../src/core/session-integration-service.js';
import type { SessionExecution, SessionTurnObservation } from '../../src/core/session-ports.js';
import type { SessionIntegrationInput } from '../../src/domain/session-integrations.js';
import { MemoryAgentsStore } from './fixtures.js';

export async function integrationFixture() {
  const store = new MemoryAgentsStore();
  const observations = new Map<string, SessionTurnObservation>();
  const execution: SessionExecution = {
    prepare: async (_owner, _id, environment) => { if (environment.type !== 'none') throw new Error('Fixture uses no environment'); return environment; },
    start: vi.fn(async (_owner, _session, binding) => { observations.set(binding.turn.id, { turn: { ...binding.turn, status: 'in_progress', started_at: 1 }, requiredActions: [] }); }),
    steer: vi.fn(async () => {}), cancel: vi.fn(async (_owner, _session, turnId) => { const previous = observations.get(turnId)!; observations.set(turnId, { turn: { ...previous.turn, status: 'cancelled', completed_at: 2 }, requiredActions: [] }); }),
    toolResult: async () => {}, observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
    items: async (_owner, _session, turnId) => [{ id: `answer_${turnId}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', turn_id: turnId, content: [{ type: 'output_text', text: 'The answer', annotations: [] }] }],
    artifacts: async () => [], artifactContent: async () => new ReadableStream(),
  };
  const agents = new AgentService({ store });
  const agent = await agents.create('operator', { model: 'test' });
  const sessions = new SessionService({ store, agents, execution });
  const delivery = { deliver: vi.fn(async () => {}) };
  const integrations = new SessionIntegrationService({ store, sessions, delivery });
  const target = { agentId: agent.id, environment: { type: 'none' as const } };
  const input: SessionIntegrationInput = { id: 'event-1', text: 'Question', source: { kind: 'slack', teamId: 'T1', channelId: 'C1', userId: 'U1', eventId: 'E1', threadTs: '1' }, actor: { kind: 'human', provider: 'slack', id: 'slack:T1:U1' }, credentialSubject: { kind: 'runtime', id: 'runtime:slack' } };
  return { store, sessions, integrations, delivery, observations, execution, target, input, agent };
}
