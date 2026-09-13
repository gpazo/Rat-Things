import { getScheduleService } from '../app/composition.js';

/** The deployed Lambda name is retained so existing schedule-group IAM remains valid. */
export async function handler(event: unknown) { return getScheduleService().invoke(event); }
