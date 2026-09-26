import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { quickstartAgent, quickstartTurnEvidence, runQuickstartProof } from '../../scripts/agents-quickstart-proof.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { integrationFixture } from '../agents/integration-fixtures.js';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';

async function fixture(wrongOutput = false) {
  const f = await integrationFixture();
  const agents = new AgentService({ store: f.store });
  const outputs = new Map<string, string>();
  vi.spyOn(f.execution, 'start').mockImplementation(async (_owner, _session, binding) => {
    const text = binding.input.flatMap((message) => message.content.flatMap((part) => part.type === 'input_text' ? [part.text] : [])).join('\n');
    outputs.set(binding.turn.id, wrongOutput ? 'An unrelated answer' : text);
    f.observations.set(binding.turn.id, { turn: { ...binding.turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
  });
  vi.spyOn(f.execution, 'items').mockImplementation(async (_owner, _session, turnId) => [{ id: `item_${turnId}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', turn_id: turnId, content: [{ type: 'output_text', text: outputs.get(turnId) ?? '' }] }]);
  const requests: string[] = [];
  const client = new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: (input, init) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return routeAgentsRequest(request, iamApiPrincipal('operator'), { agents, sessions: f.sessions });
  } });
  let time = 0;
  const wait = async () => {
    time += 10;
    for (const session of (await f.sessions.list('operator')).data) {
      await f.sessions.dispatch('operator', session.id);
      await f.sessions.completeReadyTurns('operator', session.id);
    }
  };
  return { ...f, client, requests, wait, now: () => time };
}

describe('Agents quickstart proof', () => {
  it('uses the SDK for two root Turns and stops the disposable Session while retaining its Agent', async () => {
    const f = await fixture();
    const result = await runQuickstartProof(f.client.beta.agents, { model: 'configured-model', marker: 'PROOF_MARKER', wait: f.wait, now: f.now, timeoutMs: 100 });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]!.turnId).not.toBe(result.turns[1]!.turnId);
    expect(result.turns[1]!.outputPreview).toContain('PROOF_MARKER-CONTINUED');
    expect(result.sessionDeleted).toBe(true);
    await expect(f.sessions.retrieve('operator', result.sessionId)).rejects.toMatchObject({ status: 404 });
    expect(await f.client.beta.agents.retrieve(result.agentId)).toMatchObject(quickstartAgent('configured-model'));
    expect(f.requests.some((path) => /things|runs|conversations/.test(path))).toBe(false);
  });
  it('does not claim success from unrelated output and still deletes the proof Session', async () => {
    const f = await fixture(true);
    await expect(runQuickstartProof(f.client.beta.agents, { model: 'configured-model', marker: 'PROOF_MARKER', wait: f.wait, now: f.now, timeoutMs: 100 })).rejects.toThrow('did not contain its proof marker');
    expect((await f.sessions.list('operator')).data).toEqual([]);
  });
  it('requires exact Session/Agent/root identities and excludes commentary and other Turns', async () => {
    const f = await fixture();
    const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'start' });
    const turn = { ...(await f.sessions.turns('operator', session.id)).data[0]!, status: 'completed' as const };
    const expected = { agentId: f.agent.id, sessionId: session.id, marker: 'PROOF' };
    const item: Extract<AgentSessionItem, { type: 'message' }> = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', turn_id: turn.id, content: [{ type: 'output_text', text: 'PROOF' }] };
    const before = structuredClone({ session, turn, item });
    expect(quickstartTurnEvidence(session, turn, [item], expected)).toMatchObject({ outputPreview: 'PROOF' });
    expect(() => quickstartTurnEvidence(session, { ...turn, subagent_id: 'child' }, [item], expected)).toThrow('expected Agent');
    expect(() => quickstartTurnEvidence(session, turn, [{ ...item, phase: 'commentary' }], expected)).toThrow('proof marker');
    expect(() => quickstartTurnEvidence(session, turn, [{ ...item, turn_id: 'other' }], expected)).toThrow('proof marker');
    expect({ session, turn, item }).toEqual(before);
  });
});
