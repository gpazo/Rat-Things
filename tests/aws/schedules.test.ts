import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { sessionScheduleName } from '../../src/adapters/eventbridge-session-scheduler.js';
import type { Schedule } from '../../src/domain/schedules.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SCHEDULE_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live('synchronizes an owned schedule through the outbox and executes one canonical Session', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live schedule validation requires explicit model opt-in');
  const region = required('AWS_REGION');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
  const control = createAgentsClient({ baseURL: new URL('/v1', required('RAT_THINGS_API_URL')).href, region }).withOptions({ maxRetries: 0 });
  const scheduler = new SchedulerClient({ region });
  const marker = `scheduled-${randomUUID()}`;
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [], instructions: 'Return the exact marker requested by the user.' });
  let schedule: Schedule | undefined;
  try {
    // Two minutes allows the table stream/outbox to synchronize before invocation.
    const at = new Date(Date.now() + 120_000).toISOString().slice(0, 19);
    schedule = await control.post<Schedule>('/schedules', { body: { name: marker, agentId: agent.id,
      environment: { type: 'none' }, input: `Return exactly ${marker}.`, expression: `at(${at})`, timezone: 'UTC', destinations: [{ kind: 'none' }] } });
    const owned = schedule;
    await eventually(async () => {
      const saved = await remoteSchedule(owned.id);
      if (!saved) return false;
      expect(saved.State).toBe('ENABLED');
      expect(saved.ScheduleExpression).toBe(owned.expression);
      expect(saved.Target?.Arn).toContain(`rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`);
      expect(saved.Target?.RoleArn?.split(':')[4]).toBe(required('AWS_E2E_CALLER_ACCOUNT'));
      expect(JSON.parse(saved.Target!.Input!)).toMatchObject({ scheduleId: owned.id, generation: owned.generation });
      return true;
    });
    let sessionId: string | undefined;
    await eventually(async () => {
      const sessions = await client.beta.agents.sessions.list({ agent_id: agent.id, limit: 100 });
      expect(sessions.data.length).toBeLessThanOrEqual(1);
      sessionId = sessions.data[0]?.id;
      if (!sessionId) return false;
      const turns = (await client.beta.agents.sessions.turns.list(sessionId)).data.filter(turn => turn.subagent_id === null);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      if (['failed', 'cancelled'].includes(turn.status)) throw new Error(`Scheduled Turn ended ${turn.status}: ${turn.error?.code}`);
      return turn.status === 'completed';
    });
    const items = (await client.beta.agents.sessions.items.list(sessionId!, { order: 'asc', limit: 100 })).data;
    expect(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.includes(marker)))).toBe(true);
    console.log(JSON.stringify({ scheduleId: schedule.id, sessionId, expression: schedule.expression }));
  } finally {
    try {
      if (schedule) {
        await control.delete(`/schedules/${schedule.id}`);
        const id = schedule.id;
        await eventually(async () => !await remoteSchedule(id));
      }
    } finally {
      try {
        const sessions = await client.beta.agents.sessions.list({ agent_id: agent.id, limit: 100 });
        const deleted = await Promise.allSettled(sessions.data.map(session => client.beta.agents.sessions.delete(session.id)));
        const failures = deleted.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Disposable schedule Sessions could not be deleted');
      } finally { try { await client.beta.agents.delete(agent.id); } finally { scheduler.destroy(); } }
    }
  }

  async function remoteSchedule(id: string) {
    try { return await scheduler.send(new GetScheduleCommand({ GroupName: required('THING_SCHEDULE_GROUP_NAME'), Name: sessionScheduleName(id) })); }
    catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined; throw error; }
  }
}, timeoutMs * 2);

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('Scheduled Session proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live schedule validation`);
  return value;
}
