import { getWatchdogService } from '../app/watchdog-composition.js';

export async function handler() {
  const result = await getWatchdogService().tick();
  console.info(JSON.stringify({ message: 'Watchdog scan completed', ...result }));
  return result;
}
