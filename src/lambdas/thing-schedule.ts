import type { ScheduledThingInvocation, ScheduledThingResult } from '../domain/things.js';
import { getThingService } from '../app/composition.js';

/** Fixed, non-public target for deployment-owned EventBridge Scheduler schedules. */
export async function handler(event: ScheduledThingInvocation): Promise<ScheduledThingResult> {
  return getThingService().runScheduled(event);
}
