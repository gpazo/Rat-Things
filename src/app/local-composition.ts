import { join } from 'node:path';
import { AgentService } from '../core/agent-service.js';
import { SessionService } from '../core/session-service.js';
import type { SessionState } from '../core/session-ports.js';
import { EnvironmentTemplateService } from '../core/environment-template-service.js';
import { SqliteAgentsStore } from '../adapters/sqlite-agents-store.js';
import type { LocalSessionExecution } from '../runner/local-session-execution.js';
import { EnvironmentService } from '../core/environment-service.js';
import type { HarnessId, LocalHarness } from '../core/harness-ports.js';
import { LocalManagedEnvironment } from '../runner/local-managed-environment.js';
import { createCodexLocalHarness } from '../runner/local-codex-harness.js';
import { LocalTransferService } from './local-transfer.js';
import { createLocalRuntime } from './local-runtime.js';
import type { LocalRuntime } from '../core/local-runtime-ports.js';
import { developmentLocalCodexHost, type LocalCodexHostProvider } from '../runner/local-codex.js';
import { LocalNativeService, type LocalNativeServiceOptions } from './local-native-service.js';

export const LOCAL_OWNER = 'local-workspace';

export function createLocalServices(options: {
  directory: string; model?: string; maxSessions?: number; harness?: HarnessId;
  runtime?: LocalRuntime | undefined;
  hostCodex?: LocalCodexHostProvider | undefined;
  native?: LocalNativeServiceOptions | undefined;
  execution?: ((store: SqliteAgentsStore, managed: LocalManagedEnvironment) => LocalSessionExecution) | undefined;
}) {
  const maxSessions = options.maxSessions ?? 2;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) throw new Error('Local capacity must be an integer from 1 to 32.');
  if ((options.harness ?? 'codex') !== 'codex') throw new Error('The pi harness is not available yet. Use the Codex harness.');
  if (options.native && (options.runtime || options.hostCodex)) throw new Error('Installed native services select their own runtime and host Codex.');
  const store = new SqliteAgentsStore(options.directory);
  try { store.acquireServerLease(); } catch (error) { store.close(); throw error; }
  const agents = new AgentService({ store });
  const templates = new EnvironmentTemplateService({ store });
  const environments: EnvironmentService = new EnvironmentService({ store, templates,
    credentials: { create: async () => { throw new Error('Self-hosted local connections are unavailable'); }, read: async () => { throw new Error('Local Vault is unavailable'); }, revoke: async () => {} },
    managedFiles: (owner, session, operation) => managed.files(owner, session, operation),
  });
  let native: LocalNativeService | undefined;
  let runtime: LocalRuntime;
  let managed: LocalManagedEnvironment;
  let harness: LocalHarness;
  try {
    if (options.native) native = new LocalNativeService({ profileDirectory: options.directory,
      assertHeld: () => store.assertServerLease(), runWhileHeld: work => store.runWhileServerLeaseHeld(work) }, options.native, { store, owner: LOCAL_OWNER });
    runtime = native?.runtime ?? options.runtime ?? createLocalRuntime(options.directory);
    const hostCodex = native?.hostCodex ?? options.hostCodex ?? developmentLocalCodexHost(options.directory);
    managed = new LocalManagedEnvironment({ store, runtime, environments, maxSessions, hostCodex });
    harness = createCodexLocalHarness({ store, directory: options.directory, maxSessions, managed, model: options.model, hostCodex, execution: options.execution?.(store, managed) });
  }
  catch (error) { store.close(true); throw error; }
  const { execution, account: subscription } = harness;
  const sessions = new SessionService({ store, agents, execution, streamIntervalMs: 100 });
  const transfers = new LocalTransferService({ store, sessions, environments, owner: LOCAL_OWNER, snapshot: id => managed.snapshot(id) });
  let stopped = false;
  let closed: Promise<void> | undefined;
  let ticking: Promise<void> | undefined;
  const tick = async () => {
    let after: string | undefined;
    do {
      const page = await store.list<SessionState>(LOCAL_OWNER, 'sessions', { limit: 100, ...(after ? { after } : {}) });
      for (const resource of page.data) {
        if (stopped || native && !native.ready()) return;
        if (Object.values(resource.value.receipts).some(receipt => !receipt.dispatched)
          || resource.value.session.environment.type === 'openai_hosted'
            && (await environments.retrieve(LOCAL_OWNER, resource.value.session.environment.id)).status === 'pending') {
          await sessions.dispatch(LOCAL_OWNER, resource.id).catch(() => undefined);
        }
      }
      after = page.has_more ? page.data.at(-1)?.id : undefined;
    } while (after);
  };
  const timer = setInterval(() => {
    if (!ticking && !stopped && (!native || native.ready())) ticking = tick().catch(() => undefined).finally(() => { ticking = undefined; });
  }, 100);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    void native?.stop();
  };
  return {
    agents, sessions, templates, environments, subscription, transfers, runtime, runtimeChanges: native,
    directory: options.directory, maxSessions,
    harness: harness.id,
    models: () => harness.models(),
    start: () => native?.start(),
    runtimeReady: () => !native || native.ready(),
    runtimeStatus: () => native ? Promise.resolve(native.status()) : runtime.status(),
    stop,
    close() {
      closed ??= (async () => {
      stop();
      const startupStopped = native?.stop();
      await ticking;
      await startupStopped;
      await store.drainServerLease();
      const failures: unknown[] = [];
      for (const stop of [() => transfers.close(), () => harness.close(), () => execution.shutdown(), () => managed.shutdown(), () => native?.close()]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Local workspace shutdown did not complete.');
      store.close(true);
      })();
      return closed;
    },
    connectionPath: join(options.directory, 'connection.json'),
  };
}
