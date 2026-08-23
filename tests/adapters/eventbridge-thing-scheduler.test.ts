import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { describe, expect, it, vi } from 'vitest';
import {
  EventBridgeThingScheduler,
  thingScheduleName,
} from '../../src/adapters/eventbridge-thing-scheduler.js';

describe('EventBridgeThingScheduler', () => {
  it('creates a fixed-target schedule with a pinned revision and Scheduler timestamp', async () => {
    const notFound = Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
    const send = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce({});
    const scheduler = fixture(send);

    await scheduler.upsert({
      thingId: 'thing-customer-ops',
      revision: 7,
      trigger: {
        kind: 'schedule',
        expression: 'cron(0 8 ? * MON-FRI *)',
        timezone: 'America/Los_Angeles',
      },
    }, true);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetScheduleCommand);
    const command = send.mock.calls[1]?.[0] as CreateScheduleCommand;
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input).toMatchObject({
      Name: thingScheduleName('thing-customer-ops'),
      GroupName: 'rat-things-live-things',
      ScheduleExpression: 'cron(0 8 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'America/Los_Angeles',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: 'arn:aws:lambda:us-west-2:123456789012:function:thing-schedule',
        RoleArn: 'arn:aws:iam::123456789012:role/thing-schedule',
        DeadLetterConfig: { Arn: 'arn:aws:sqs:us-west-2:123456789012:thing-failures' },
        RetryPolicy: { MaximumEventAgeInSeconds: 86400, MaximumRetryAttempts: 185 },
      },
    });
    expect(JSON.parse(command.input.Target?.Input ?? '{}')).toEqual({
      version: '1',
      thingId: 'thing-customer-ops',
      revision: 7,
      scheduledAt: '<aws.scheduler.scheduled-time>',
    });
  });

  it('updates an existing schedule and can disable it', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const scheduler = fixture(send);
    await scheduler.upsert({
      thingId: 'thing-1',
      revision: 2,
      trigger: { kind: 'schedule', expression: 'rate(1 hour)' },
    }, false);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(UpdateScheduleCommand);
    expect((send.mock.calls[1]?.[0] as UpdateScheduleCommand).input).toMatchObject({
      State: 'DISABLED',
      ScheduleExpression: 'rate(1 hour)',
    });
    expect((send.mock.calls[1]?.[0] as UpdateScheduleCommand).input)
      .not.toHaveProperty('ScheduleExpressionTimezone');
  });

  it('makes removal idempotent and uses an opaque bounded schedule name', async () => {
    const notFound = Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
    const send = vi.fn().mockRejectedValueOnce(notFound);
    const scheduler = fixture(send);
    await expect(scheduler.remove('Thing_With_unsafe/provider/value')).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteScheduleCommand);
    const name = (send.mock.calls[0]?.[0] as DeleteScheduleCommand).input.Name;
    expect(name).toMatch(/^thing-[a-f0-9]{48}$/);
    expect(name).not.toContain('unsafe');
  });
});

function fixture(send: ReturnType<typeof vi.fn>): EventBridgeThingScheduler {
  return new EventBridgeThingScheduler(
    { send } as unknown as SchedulerClient,
    {
      groupName: 'rat-things-live-things',
      targetArn: 'arn:aws:lambda:us-west-2:123456789012:function:thing-schedule',
      executionRoleArn: 'arn:aws:iam::123456789012:role/thing-schedule',
      deadLetterArn: 'arn:aws:sqs:us-west-2:123456789012:thing-failures',
    },
  );
}
