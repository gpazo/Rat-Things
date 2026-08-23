import { createHash } from 'node:crypto';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import type { ThingScheduler, ThingSchedulerTarget } from '../core/ports.js';

export interface EventBridgeThingSchedulerOptions {
  groupName: string;
  targetArn: string;
  executionRoleArn: string;
  deadLetterArn?: string;
}

/** Maps one active Thing to one deployment-owned EventBridge Scheduler schedule. */
export class EventBridgeThingScheduler implements ThingScheduler {
  public constructor(
    private readonly client: SchedulerClient,
    private readonly options: EventBridgeThingSchedulerOptions,
  ) {}

  public async upsert(target: ThingSchedulerTarget, enabled: boolean): Promise<void> {
    const name = thingScheduleName(target.thingId);
    const scheduleTarget = {
      Arn: this.options.targetArn,
      RoleArn: this.options.executionRoleArn,
      Input: JSON.stringify({
        version: '1',
        thingId: target.thingId,
        revision: target.revision,
        scheduledAt: '<aws.scheduler.scheduled-time>',
      }),
      RetryPolicy: {
        MaximumEventAgeInSeconds: 86_400,
        MaximumRetryAttempts: 185,
      },
      ...(this.options.deadLetterArn
        ? { DeadLetterConfig: { Arn: this.options.deadLetterArn } }
        : {}),
    };
    const common = {
      Name: name,
      GroupName: this.options.groupName,
      Description: `Rat Thing ${target.thingId} revision ${target.revision}`.slice(0, 512),
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      ScheduleExpression: target.trigger.expression,
      ...(target.trigger.timezone
        ? { ScheduleExpressionTimezone: target.trigger.timezone }
        : {}),
      State: enabled ? 'ENABLED' as const : 'DISABLED' as const,
      Target: scheduleTarget,
    };

    try {
      await this.client.send(new GetScheduleCommand({
        Name: name,
        GroupName: this.options.groupName,
      }));
      await this.client.send(new UpdateScheduleCommand(common));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await this.client.send(new CreateScheduleCommand(common));
      } catch (createError) {
        if (!isConflict(createError)) throw createError;
        await this.client.send(new UpdateScheduleCommand(common));
      }
    }
  }

  public async remove(thingId: string): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({
        Name: thingScheduleName(thingId),
        GroupName: this.options.groupName,
      }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function thingScheduleName(thingId: string): string {
  return `thing-${createHash('sha256').update(thingId).digest('hex').slice(0, 48)}`;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { name?: string }).name === 'ResourceNotFoundException' ||
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  ));
}

function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { name?: string }).name === 'ConflictException' ||
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 409
  ));
}
