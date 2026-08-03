import { runAgentWorker } from './main.js';

runAgentWorker().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'agent worker failed',
    error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  }));
  process.exitCode = 1;
});
