import type { AgentsStore } from '../core/agents-ports.js';
import type { LocalHarness } from '../core/harness-ports.js';
import { createModelCatalog, type ModelCatalog } from '../core/model-catalog.js';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { planCodexLaunch } from './agent-planning.js';
import { developmentLocalCodexHost, localCodexArguments, localCodexEnvironment, type LocalCodexHostProvider } from './local-codex.js';
import type { LocalManagedEnvironment } from './local-managed-environment.js';
import { LocalSessionExecution } from './local-session-execution.js';
import { LocalSubscription } from './local-subscription.js';

/** Codex runs on the host with a private Codex home and signs in with ChatGPT. */
export function createCodexLocalHarness(options: {
  store: AgentsStore; directory: string; maxSessions: number; managed: LocalManagedEnvironment; model?: string | undefined;
  execution?: LocalSessionExecution | undefined;
  account?: LocalSubscription;
  hostCodex?: LocalCodexHostProvider;
}): LocalHarness {
  const hostCodex = options.hostCodex ?? developmentLocalCodexHost(options.directory);
  let pending: Promise<ModelCatalog | undefined> | undefined;
  let models = options.model ? createModelCatalog({ modelIds: [options.model], defaultModel: options.model }) : undefined;
  if (options.model && !models) throw new Error('Invalid local model ID.');
  const account = options.account ?? new LocalSubscription(options.directory, hostCodex);
  return {
    id: 'codex',
    account,
    execution: options.execution ?? new LocalSessionExecution({ store: options.store, directory: options.directory, maxSessions: options.maxSessions, managed: options.managed, hostCodex }),
    async models() {
      if (models) return models;
      pending ??= (async () => {
        const host = hostCodex();
        const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, options.directory, 10_000,
          localCodexEnvironment(options.directory, { ...host.environment, CODEX_BINARY: host.binary }));
        const rpc = new CodexRpcClient({ binary: plan.binary, binaryArguments: localCodexArguments(plan.binaryArguments ?? ['app-server']), cwd: options.directory, environment: plan.environment });
        try {
          await rpc.initialize();
          const result = await rpc.call('model/list', {}, 5_000) as { data?: Array<{ id: string; model?: string; isDefault?: boolean }> };
          const data = result.data ?? [];
          const defaultModel = data.find(model => model.isDefault);
          models = createModelCatalog({ modelIds: data.map(model => model.model ?? model.id),
            ...(defaultModel ? { defaultModel: defaultModel.model ?? defaultModel.id } : {}) });
          return models;
        } finally { await rpc.close(); }
      })().finally(() => { pending = undefined; });
      return pending;
    },
    async close() { await pending?.catch(() => undefined); await account.close(); },
  };
}
