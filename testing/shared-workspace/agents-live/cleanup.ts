import type { Turn } from '../../../src/domain/agents-api.js';

export type LiveTurnUsage = Pick<Turn, 'id' | 'status' | 'usage'>;

export type CleanupOutcome = { status: 'removed' } | { status: 'failed'; error: string };

export type VolumeCleanupOutcome =
  | { status: 'removed'; name: string; detail?: string }
  | { status: 'not_created' }
  | { status: 'failed'; name: string; error: string; retained?: true };

export interface AgentsLiveCleanupResult {
  status: 'removed' | 'incomplete';
  resources: {
    loopback_server: CleanupOutcome;
    local_services: CleanupOutcome;
    connection_file: CleanupOutcome;
    worker_volume: VolumeCleanupOutcome;
    state_volume: VolumeCleanupOutcome;
  };
  usage: { status: 'read'; turns: LiveTurnUsage[] } | { status: 'failed'; error: string };
}

export async function cleanupAgentsLive(effects: {
  stopServer(): void | Promise<void>;
  readTurns(): Promise<LiveTurnUsage[]>;
  closeServices(): void | Promise<void>;
  removeConnectionFile(): void | Promise<void>;
  removeVolume(name: string): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  volumes?: readonly [worker: string, state: string];
  writeEvidence(result: AgentsLiveCleanupResult): void | Promise<void>;
}): Promise<{ result: AgentsLiveCleanupResult; exitCode: 0 | 1; evidenceError?: string }> {
  const loopbackServer = await outcome(effects.stopServer);
  let usage: AgentsLiveCleanupResult['usage'];
  try { usage = { status: 'read', turns: await effects.readTurns() }; }
  catch (error) { usage = { status: 'failed', error: errorMessage(error) }; }
  const localServices = await outcome(effects.closeServices);
  const connectionFile = await outcome(effects.removeConnectionFile);
  const [workerVolume, stateVolume] = effects.volumes
    ? await Promise.all(effects.volumes.map(name => removeVolume(name, effects.removeVolume, effects.volumeExists)))
    : [{ status: 'not_created' } as const, { status: 'not_created' } as const];
  const resources = {
    loopback_server: loopbackServer,
    local_services: localServices,
    connection_file: connectionFile,
    worker_volume: workerVolume,
    state_volume: stateVolume,
  };
  const complete = usage.status === 'read' && Object.values(resources).every(item => item.status === 'removed' || item.status === 'not_created');
  const result: AgentsLiveCleanupResult = { status: complete ? 'removed' : 'incomplete', resources, usage };
  try {
    await effects.writeEvidence(result);
    return { result, exitCode: complete ? 0 : 1 };
  } catch (error) {
    return { result, exitCode: 1, evidenceError: errorMessage(error) };
  }
}

async function outcome(action: () => void | Promise<void>): Promise<CleanupOutcome> {
  try { await action(); return { status: 'removed' }; }
  catch (error) { return { status: 'failed', error: errorMessage(error) }; }
}

async function removeVolume(
  name: string,
  remove: (name: string) => Promise<void>,
  exists: (name: string) => Promise<boolean>,
): Promise<VolumeCleanupOutcome> {
  try { await remove(name); return { status: 'removed', name }; }
  catch (error) {
    const removalError = errorMessage(error);
    try {
      if (await exists(name)) return { status: 'failed', name, error: removalError, retained: true };
      return { status: 'removed', name, detail: 'Volume was already absent after the removal command failed.' };
    } catch (verificationError) {
      return { status: 'failed', name, error: `${removalError}; volume state could not be verified: ${errorMessage(verificationError)}` };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
