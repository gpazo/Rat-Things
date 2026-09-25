import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { Turn } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_MULTI_AGENT_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live.each([1, 6])('enforces deployed capacity %i across blocked children and repeated interrupted follow-ups', async limit => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live multi-agent validation requires explicit model opt-in');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const marker = `multi-agent-${randomUUID()}`;
  const holdTask = `Run python3 -u -c 'import time; print("${marker}", flush=True); time.sleep(900)' using command execution. If it returns a process ID, keep waiting for that same process with write_stdin and the longest allowed wait. Do not finish your Turn before the process exits or you are interrupted. Do not create any subagents.`;
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), name: `Disposable capacity ${limit} proof`,
    multi_agent: { enabled: true, max_concurrent_subagents: limit },
    instructions: 'Use native subagent tools exactly as requested. Only children execute the requested long-running commands. The coordinator never runs those commands itself. Never invent subagent results.', tools: [] });
  let sessionId: string | undefined;
  let proofFailed = false;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'openai_hosted', network: { access: 'disabled' } } });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', sessionId, capacity: limit }));
    await rootInput(`Spawn exactly ${limit} native subagents named parity_1 through parity_${limit}. Give each child this task: ${holdTask} After spawning the children, finish your own Turn immediately without waiting for them. Do not create any other agents.`);
    let children: Awaited<ReturnType<typeof client.beta.agents.sessions.subagents.list>>['data'] = [];
    await eventually(async () => {
      children = (await client.beta.agents.sessions.subagents.list(session.id)).data;
      if (children.length !== limit) return false;
      return await heldChildren() === limit;
    });
    const ids = children.map(child => child.id).sort();
    const overflow = await rootInput('All existing children are occupied. Attempt exactly one extra native subagent named overflow with the task "Return DONE". Do not interrupt, close or reuse any existing child. After the attempt, finish your Turn. Do not retry a rejected admission.');
    const overflowItems = await rootItems(overflow.id);
    expect(overflowItems).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'create_subagent_call', status: 'failed' })]));
    expect((await client.beta.agents.sessions.subagents.list(session.id)).data.map(child => child.id).sort()).toEqual(ids);
    const target = ids[0]!;
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = (await client.beta.agents.sessions.turns.list(session.id, { limit: 100, order: 'asc' })).data.find(turn => turn.subagent_id === target && turn.status === 'in_progress');
      expect(before).toBeDefined();
      const parent = await rootInput(`Interrupt native subagent ${target}. Immediately send that same subagent a follow-up TASK: ${holdTask} Use the follow-up-task tool; do not merely send a message to a stopped child. Do not create or close agents, and do not wait for the child. Finish your own Turn after dispatch. This is interruption cycle ${cycle + 1}.`);
      await eventually(async () => {
        const turns = (await client.beta.agents.sessions.turns.list(session.id, { limit: 100, order: 'asc' })).data;
        return turns.find(turn => turn.id === before!.id)?.status === 'cancelled'
          && turns.some(turn => turn.subagent_id === target && turn.id !== before!.id && turn.status === 'in_progress')
          && await heldChildren() === limit;
      });
      const items = await rootItems(parent.id);
      expect(items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'interrupt_subagent_call', recipient_agent_id: target, status: 'completed' }),
        expect.objectContaining({ type: 'send_subagent_input_call', recipient_agent_id: target, status: 'completed' }),
      ]));
      expect((await client.beta.agents.sessions.subagents.list(session.id)).data.map(child => child.id).sort()).toEqual(ids);
    }
    await rootInput(`Interrupt subagent ${target} once more. Send that same child a follow-up TASK to return exactly ${marker} without calling any functions. Wait for it to finish, then return its answer. Do not create or close agents.`);
    const items = (await client.beta.agents.sessions.subagents.items.list(target, { session_id: session.id, limit: 100, order: 'asc' })).data;
    expect(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.includes(marker)))).toBe(true);
    console.log(JSON.stringify({ sessionId: session.id, capacity: limit, interruptedFollowUps: 3, childId: target }));
  } catch (error) {
    proofFailed = true;
    // Preserve the original failure even when a diagnostic read or cleanup fails.
    if (sessionId) {
      const evidence = await Promise.allSettled([
        client.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })
          .then(page => page.data.map(turn => ({ id: turn.id, subagent_id: turn.subagent_id, status: turn.status, error: turn.error }))),
        client.beta.agents.sessions.subagents.list(sessionId)
          .then(page => page.data.map(child => ({ id: child.id, name: child.name, status: child.status }))),
        client.beta.agents.sessions.items.list(sessionId, { limit: 100, order: 'desc' })
          .then(page => page.data.map(item => ({ id: item.id, type: item.type, ...('status' in item ? { status: item.status } : {}) }))),
      ]);
      console.error(JSON.stringify({ phase: 'failed', sessionId, capacity: limit, evidence }));
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...(sessionId ? [client.beta.agents.sessions.delete(sessionId)] : []),
      client.beta.agents.delete(agent.id),
    ]);
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) {
      console.error(JSON.stringify({ phase: 'cleanup_failed', sessionId, failures }));
      if (!proofFailed) throw new AggregateError(failures.map(result => result.reason), 'Multi-agent proof cleanup failed');
    }
  }

  async function heldChildren() {
    const turns = (await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100, order: 'asc' })).data;
    const failed = turns.find(turn => turn.subagent_id && turn.status === 'failed');
    if (failed) throw new Error(`Child Turn ${failed.id} failed: ${failed.error?.code}`);
    const active = turns.filter(turn => turn.subagent_id && turn.status === 'in_progress');
    const held = await Promise.all(active.map(async turn => {
      const items = (await client.beta.agents.sessions.subagents.items.list(turn.subagent_id!, { session_id: sessionId!, limit: 100, order: 'desc' })).data;
      return items.some(item => item.turn_id === turn.id && item.type === 'command_execution' && JSON.stringify(item).includes(marker)) ? turn.subagent_id : null;
    }));
    return new Set(held.filter(Boolean)).size;
  }
  async function rootItems(turnId: string) {
    const items = [];
    for await (const item of client.beta.agents.sessions.items.list(sessionId!, { limit: 100, order: 'asc' })) {
      if (item.turn_id === turnId) items.push(item);
    }
    return items;
  }
  async function rootInput(text: string): Promise<Turn> {
    console.log(JSON.stringify({ phase: 'coordinator_input', sessionId, capacity: limit }));
    const previous = new Set((await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100 })).data.map(turn => turn.id));
    await client.beta.agents.sessions.events.create(sessionId!, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
    let turn: Turn | undefined;
    await eventually(async () => {
      turn = (await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100, order: 'asc' })).data.find(value => value.subagent_id === null && !previous.has(value.id));
      if (turn && ['failed', 'cancelled', 'waiting'].includes(turn.status)) throw new Error(`Coordinator Turn ${turn.id} ended or blocked as ${turn.status}: ${turn.error?.code}`);
      return turn?.status === 'completed';
    });
    console.log(JSON.stringify({ phase: 'coordinator_completed', sessionId, turnId: turn!.id, capacity: limit }));
    return turn!;
  }
}, timeoutMs * 8);

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('Multi-agent proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live multi-agent validation`);
  return value;
}
