import { createHash } from 'node:crypto';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import type { SessionScheduler } from '../core/schedule-service.js';
import type { Schedule } from '../domain/schedules.js';

export interface EventBridgeSessionSchedulerOptions {
  groupName: string;
  targetArn: string;
  executionRoleArn: string;
  deadLetterArn?: string;
}

/** Maps one Agent schedule to one deployment-owned EventBridge Scheduler schedule. */
export class EventBridgeSessionScheduler implements SessionScheduler {
  public constructor(
    private readonly client: SchedulerClient,
    private readonly options: EventBridgeSessionSchedulerOptions,
  ) {}

  public async upsert(ownerId: string, target: Schedule): Promise<void> {
    const name = sessionScheduleName(target.id);
    const scheduleTarget = {
      Arn: this.options.targetArn,
      RoleArn: this.options.executionRoleArn,
      Input: JSON.stringify({
        ownerId,
        scheduleId: target.id,
        generation: target.generation,
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
      Description: `Rat schedule ${target.id} revision ${target.generation}`.slice(0, 512),
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      ScheduleExpression: target.expression,
      ...(target.timezone
        ? { ScheduleExpressionTimezone: target.timezone }
        : {}),
      State: target.status === 'active' ? 'ENABLED' as const : 'DISABLED' as const,
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

  public async remove(id: string): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({
        Name: sessionScheduleName(id),
        GroupName: this.options.groupName,
      }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function sessionScheduleName(id: string): string {
  return `session-${createHash('sha256').update(id).digest('hex').slice(0, 48)}`;
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
