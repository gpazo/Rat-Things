import { describe, expect, it, vi } from 'vitest';
import { ScheduleService } from '../../src/core/schedule-service.js';
import { integrationFixture } from './integration-fixtures.js';

async function fixture() {
  const f = await integrationFixture();
  const scheduler = { upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const service = new ScheduleService({ store: f.store, sessions: f.sessions, integrations: f.integrations, scheduler, validateTarget: async () => {} });
  const config = { ...f.target, name: 'Daily check', expression: 'rate(1 day)', input: 'Check {{scheduled_at}}', overlap: 'skip' };
  const schedule = await service.create('operator', config);
  const invocation = { ownerId: 'operator', scheduleId: schedule.id, generation: schedule.generation, scheduledAt: '2026-09-12T10:00:00Z' };
  return { ...f, service, scheduler, config, schedule, invocation };
}

describe('Agent schedules', () => {
  it('synchronizes the owned schedule independently of API acknowledgement', async () => {
    const f = await fixture();
    expect(f.scheduler.upsert).not.toHaveBeenCalled();
    await f.service.synchronize('operator', f.schedule.id);
    expect(f.scheduler.upsert).toHaveBeenCalledWith('operator', f.schedule);
    await f.service.status('operator', f.schedule.id, 'deleted');
    await f.service.synchronize('operator', f.schedule.id);
    expect(f.scheduler.remove).toHaveBeenCalledWith(f.schedule.id);
  });
  it('deduplicates scheduled occurrences and snapshots input before later edits', async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.service.invoke(f.invocation), f.service.invoke(f.invocation)]);
    expect(one).toEqual(two);
    if (!one.accepted) throw new Error('not accepted');
    await f.service.update('operator', f.schedule.id, { ...f.config, input: 'Changed' });
    expect(await f.service.invoke(f.invocation)).toEqual(one);
    await f.integrations.submitPending('operator', one.sessionId);
    expect((await f.sessions.items('operator', one.sessionId)).data).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'Check 2026-09-12T10:00:00.000Z' }] })]));
  });
  it('recovers a reserved occurrence when acceptance failed and skips a later overlap', async () => {
    const f = await fixture();
    vi.spyOn(f.integrations, 'accept').mockRejectedValueOnce(new Error('Temporary store failure'));
    await expect(f.service.invoke(f.invocation)).rejects.toThrow('Temporary store failure');
    const next = { ...f.invocation, scheduledAt: '2026-09-13T10:00:00Z' };
    expect(await f.service.invoke(next)).toEqual({ accepted: false, reason: 'overlap' });
    const recovered = await f.service.invoke(f.invocation);
    expect(recovered.accepted).toBe(true);
    expect(await f.service.invoke(next)).toEqual({ accepted: false, reason: 'overlap' });
  });
  it('ignores stale generations and pauses, and scopes schedule ownership', async () => {
    const f = await fixture();
    await f.service.status('operator', f.schedule.id, 'paused');
    expect(await f.service.invoke(f.invocation)).toEqual({ accepted: false, reason: 'stale_schedule' });
    await expect(f.service.retrieve('other', f.schedule.id)).rejects.toMatchObject({ status: 404 });
    expect(await f.service.invoke({ ...f.invocation, ownerId: 'other' })).toEqual({ accepted: false, reason: 'schedule_missing' });
  });
  it('rejects unknown fields and falsey invalid input while preserving an empty destination list', async () => {
    const f = await fixture();
    await expect(f.service.create('operator', { ...f.config, prompt: 'Old Run field' })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.create('operator', { ...f.config, input: '' })).rejects.toMatchObject({ status: 400 });
    expect(await f.service.create('operator', { ...f.config, destinations: [] })).toMatchObject({ destinations: [] });
  });
});
