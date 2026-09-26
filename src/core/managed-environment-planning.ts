import type { StoredEnvironment } from './environment-service.js';

export interface ManagedSandboxGeneration { id: string; replaced: boolean }

/** Count replacement once per successfully prepared host generation. */
export function planManagedReadiness(value: StoredEnvironment, runId: string, sandbox: ManagedSandboxGeneration, now: number): StoredEnvironment {
  if (value.retired || value.runId !== runId || value.environment.type !== 'openai_hosted') throw new Error('Managed environment execution authority changed');
  const replaced = value.sandboxId !== sandbox.id && (value.sandboxId !== undefined || sandbox.replaced);
  return { ...value, sandboxId: sandbox.id, resetCount: (value.resetCount ?? 0) + Number(replaced), status: 'connected', connectedUntil: now + 45 };
}
