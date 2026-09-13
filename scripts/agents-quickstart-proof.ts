import { setTimeout as delay } from 'node:timers/promises';
import type OpenAI from 'openai';
import type { AgentCreateParams, AgentSession, AgentSessionItem, Turn } from '../src/domain/agents-api.js';

export interface QuickstartTurnEvidence {
  sessionId: string;
  turnId: string;
  status: 'completed';
  outputPreview: string;
}
export interface QuickstartProof {
  agentId: string;
  sessionId: string;
  sessionDeleted: true;
  turns: QuickstartTurnEvidence[];
}

/** Requests contain only the upstream model and tool configuration. */
export function quickstartAgent(model: string): AgentCreateParams {
  return { name: 'Quickstart agent', model, instructions: 'Follow the user request precisely. Keep answers brief.', tools: [] };
}

/** Select evidence from the exact root Turn; unrelated output cannot satisfy the proof. */
export function quickstartTurnEvidence(session: AgentSession, turn: Turn, items: readonly AgentSessionItem[], expected: { agentId: string; sessionId: string; marker: string }): QuickstartTurnEvidence {
  if (session.id !== expected.sessionId || session.agent.id !== expected.agentId || turn.session_id !== session.id || turn.agent_id !== expected.agentId || turn.subagent_id !== null) throw new Error('Quickstart result does not belong to the expected Agent and root Session Turn');
  if (turn.status !== 'completed') throw new Error(`Quickstart Turn ${turn.id} did not complete: ${turn.status}`);
  const text = items.filter((item) => item.turn_id === turn.id && item.type === 'message' && item.role === 'assistant' && item.status === 'completed' && item.phase !== 'commentary')
    .flatMap((item) => item.type === 'message' ? item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
  if (!text.includes(expected.marker)) throw new Error('Quickstart output did not contain its proof marker');
  return { sessionId: session.id, turnId: turn.id, status: 'completed', outputPreview: text.slice(0, 2000) };
}

/** The SDK is the effect boundary; time and waiting are explicit for deterministic local verification. */
export async function runQuickstartProof(agents: OpenAI['beta']['agents'], options: {
  model: string;
  marker: string;
  now?: () => number;
  wait?: () => Promise<void>;
  timeoutMs?: number;
  progress?: (message: string) => void;
}): Promise<QuickstartProof> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => delay(2000));
  const agent = await agents.create(quickstartAgent(options.model));
  const session = await agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: `Reply with this exact marker: ${options.marker}`, stream: false });
  const turns: QuickstartTurnEvidence[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const marker = index === 0 ? options.marker : `${options.marker}-CONTINUED`;
      if (index > 0) await agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Reply with this exact marker: ${marker}` }] }] }] }, { headers: { 'Idempotency-Key': `quickstart:${session.id}:continue` } });
      const deadline = now() + (options.timeoutMs ?? 420_000);
      for (;;) {
        const current = await agents.sessions.retrieve(session.id);
        const rootTurns = [];
        for await (const turn of agents.sessions.turns.list(session.id, { order: 'asc' })) if (turn.subagent_id === null) rootTurns.push(turn);
        const turn = rootTurns.find((entry) => !turns.some((completed) => completed.turnId === entry.id));
        if (turn && ['completed', 'failed', 'cancelled'].includes(turn.status)) {
          const items = [];
          for await (const item of agents.sessions.items.list(session.id, { order: 'asc' })) items.push(item);
          turns.push(quickstartTurnEvidence(current, turn, items, { agentId: agent.id, sessionId: session.id, marker }));
          options.progress?.(`      verified Turn ${turn.id}`);
          break;
        }
        if (current.error || now() >= deadline) throw new Error(`Quickstart Session ${session.id} did not finish its proof Turn`);
        await wait();
      }
    }
  } finally {
    // This proof is disposable; retain the Agent, but do not leave an idle billable harness.
    await agents.sessions.delete(session.id);
  }
  return { agentId: agent.id, sessionId: session.id, sessionDeleted: true, turns };
}
