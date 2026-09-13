import { CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, type SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { describe, expect, it, vi } from 'vitest';
import { EventBridgeSessionScheduler } from '../../src/adapters/eventbridge-session-scheduler.js';
import type { Schedule } from '../../src/domain/schedules.js';

const schedule: Schedule = {
  id: 'schedule-one', object: 'rat.schedule', name: 'Daily review', agentId: 'agent-one', environment: { type: 'none' },
  expression: 'rate(1 day)', input: 'Review', overlap: 'skip', status: 'active', generation: 2, created_at: 1, updated_at: 2,
};
const options = { groupName: 'owned', targetArn: 'arn:lambda', executionRoleArn: 'arn:role', deadLetterArn: 'arn:queue' };

describe('Session scheduler adapter', () => {
  it('recovers a concurrent create with a pinned occurrence envelope and preserves pause/timezone', async () => {
    const send = vi.fn().mockRejectedValueOnce({ name: 'ResourceNotFoundException' }).mockRejectedValueOnce({ name: 'ConflictException' }).mockResolvedValueOnce({});
    const adapter = new EventBridgeSessionScheduler({ send } as unknown as SchedulerClient, options);
    await adapter.upsert('owner', { ...schedule, status: 'paused', timezone: 'America/Los_Angeles' });
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([GetScheduleCommand, CreateScheduleCommand, UpdateScheduleCommand]);
    const request = send.mock.calls[2]![0].input;
    expect(request).toMatchObject({ GroupName: 'owned', State: 'DISABLED', ScheduleExpressionTimezone: 'America/Los_Angeles', Target: { Arn: options.targetArn, RoleArn: options.executionRoleArn, DeadLetterConfig: { Arn: options.deadLetterArn } } });
    expect(JSON.parse(request.Target.Input)).toEqual({ ownerId: 'owner', scheduleId: schedule.id, generation: 2, scheduledAt: '<aws.scheduler.scheduled-time>' });
    expect(request.Target.Input).not.toContain('Review');
  });
  it('treats absent schedules as deleted but propagates permission failures', async () => {
    const denied = new Error('AccessDenied');
    const send = vi.fn().mockRejectedValueOnce({ name: 'ResourceNotFoundException' }).mockRejectedValueOnce(denied);
    const adapter = new EventBridgeSessionScheduler({ send } as unknown as SchedulerClient, options);
    await expect(adapter.remove(schedule.id)).resolves.toBeUndefined();
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteScheduleCommand);
    await expect(adapter.remove(schedule.id)).rejects.toBe(denied);
  });
});
