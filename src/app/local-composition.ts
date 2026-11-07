import { LocalShareService, type ShareConnectionFactory } from './local-share.js';
import { createTeamConnectionClient } from '../client-connections.js';
import { SessionEventStore } from '../core/session-event-store.js';
import { join } from 'node:path';
import { AgentService } from '../core/agent-service.js';
import { ConfigurationHistory } from '../core/configuration-history.js';
import { ToolAuthorizationService } from '../core/tool-authorization-service.js';
import { OwnerRateLimiter } from '../core/owner-rate-limiter.js';
import { ownerRateLimits } from './owner-rate-limits.js';
import { SessionService } from '../core/session-service.js';
import type { SessionState } from '../core/session-ports.js';
import { EnvironmentTemplateService } from '../core/environment-template-service.js';
import { SqliteAgentsStore } from '../adapters/sqlite-agents-store.js';
import type { LocalSessionExecution } from '../runner/local-session-execution.js';
import { EnvironmentService } from '../core/environment-service.js';
import type { LocalHarness } from '../core/harness-ports.js';
import { LocalManagedEnvironment } from '../runner/local-managed-environment.js';
import { createCodexLocalHarness } from '../runner/local-codex-harness.js';
import { LocalTransferService } from './local-transfer.js';
import { createLocalRuntime } from './local-runtime.js';
import type { LocalRuntime } from '../core/local-runtime-ports.js';
import { developmentLocalCodexHost, type LocalCodexHostProvider } from '../runner/local-codex.js';
import { LocalNativeService, type LocalNativeServiceOptions } from './local-native-service.js';
import { LocalSubscription } from '../runner/local-subscription.js';
import { createLocalPiModels, localPiCatalog } from '../runner/local-pi-models.js';
import { LocalPiExecution } from '../runner/local-pi-execution.js';
import { localExecutionRouter } from '../runner/local-execution-router.js';
import { createPiModelCatalog, PI_CAPABILITIES } from '../core/model-catalog.js';
import type { PiModelDescriptor } from '../domain/session-runtime.js';

export const LOCAL_OWNER = 'local-workspace';

export function createLocalServices(options: {
  directory: string; model?: string; maxSessions?: number;
  shareConnection?: ShareConnectionFactory | undefined;
  runtime?: LocalRuntime | undefined;
  hostCodex?: LocalCodexHostProvider | undefined;
  native?: LocalNativeServiceOptions | undefined;
  execution?: ((store: SqliteAgentsStore, managed: LocalManagedEnvironment) => LocalSessionExecution) | undefined;
  pi?: { catalog: readonly PiModelDescriptor[]; models: ConstructorParameters<typeof LocalPiExecution>[0]['models'] } | undefined;
}) {
  const maxSessions = options.maxSessions ?? 2;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) throw new Error('Local capacity must be an integer from 1 to 32.');
  if (options.native && (options.runtime || options.hostCodex)) throw new Error('Installed native services select their own runtime and host Codex.');
  const rawStore = new SqliteAgentsStore(options.directory);
  const journal = new SessionEventStore(rawStore);
  const store = new Proxy(rawStore, { get(target, key) {
    const source = ['put', 'commit', 'commitAtObservation', 'delete'].includes(String(key)) ? journal : target;
    const value: unknown = Reflect.get(source, key);
    return typeof value === 'function' ? value.bind(source) : value;
  } });
  try { rawStore.acquireServerLease(); } catch (error) { rawStore.close(); throw error; }
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
  const piCatalog = options.pi?.catalog ?? localPiCatalog();
  try {
    if (options.native) native = new LocalNativeService({ profileDirectory: options.directory,
      assertHeld: () => rawStore.assertServerLease(), runWhileHeld: work => rawStore.runWhileServerLeaseHeld(work) }, options.native, { store, owner: LOCAL_OWNER });
    runtime = native?.runtime ?? options.runtime ?? createLocalRuntime(options.directory);
    const hostCodex = native?.hostCodex ?? options.hostCodex ?? developmentLocalCodexHost(options.directory);
    managed = new LocalManagedEnvironment({ store, runtime, environments, maxSessions, hostCodex });
    const account = new LocalSubscription(options.directory, hostCodex);
    const codex = createCodexLocalHarness({ store, directory: options.directory, maxSessions, managed, model: options.model, hostCodex, account, execution: options.execution?.(store, managed) });
    const pi = new LocalPiExecution({ store, maxSessions, managed, models: options.pi?.models ?? (pin => createLocalPiModels(pin, () => account.accessToken())) });
    harness = { ...codex, execution: localExecutionRouter(store, codex.execution, pi) };
  }
  catch (error) { rawStore.close(true); throw error; }
  const { execution, account: subscription } = harness;
  const sessions = new SessionService({ store, agents, execution, streamIntervalMs: 100, piCatalog, piManagedStorage: true,
    rateLimit: new OwnerRateLimiter(store, ownerRateLimits(process.env.OWNER_RATE_LIMITS_JSON)) });
  const transfers = new LocalTransferService({ store, sessions, environments, owner: LOCAL_OWNER, snapshot: id => managed.snapshot(id) });
  const shares = new LocalShareService({ store, sessions, environments, owner: LOCAL_OWNER, snapshot: id => managed.snapshot(id),
    connection: options.shareConnection ?? createTeamConnectionClient,
  });
  let stopped = false;
  let closed: Promise<void> | undefined;
  let ticking: Promise<void> | undefined;
  const tick = async () => {
    let after: string | undefined;
    do {
      const page = await store.list<SessionState>(LOCAL_OWNER, 'sessions', { limit: 100, ...(after ? { after } : {}) });
      for (const resource of page.data) {
        if (stopped || native && !native.ready()) return;
        if (resource.value.share && resource.value.share.phase !== 'quiescing') continue;
        if (resource.value.runtime?.kind === 'pi') await execution.reconcile?.(LOCAL_OWNER, resource.value.session).catch(() => undefined);
        if (await sessions.hasPendingFeedback(LOCAL_OWNER, resource.id) || Object.values(resource.value.receipts).some(receipt => !receipt.dispatched)
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
    agents, sessions, templates, environments, subscription, transfers, localShares: shares, runtime, runtimeChanges: native,
    history: new ConfigurationHistory(store), authorizations: new ToolAuthorizationService(store),
    directory: options.directory, maxSessions,
    harness: harness.id,
    models: () => harness.models(),
    piModels: createPiModelCatalog(piCatalog, piCatalog.find(model => model.id === (options.model ?? 'gpt-6-luna'))?.id ?? piCatalog[0]?.id,
      { ...PI_CAPABILITIES, environments: ['none', 'openai_hosted'], managed_environment_requires: [], tools: ['function'] }),
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
      await rawStore.drainServerLease();
      const failures: unknown[] = [];
      for (const stop of [() => shares.close(), () => transfers.close(), () => harness.close(), () => execution.shutdown(), () => managed.shutdown(), () => native?.close()]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Local workspace shutdown did not complete.');
      rawStore.close(true);
      })();
      return closed;
    },
    connectionPath: join(options.directory, 'connection.json'),
  };
}
