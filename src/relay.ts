import { getAgentsApiServices } from './app/composition.js';
import { createEnvironmentRelay } from './adapters/environment-relay.js';
import { requiredEnv } from './adapters/executors.js';
import { codexEnvironmentFiles } from './adapters/codex-environment-files.js';

const endpoint = requiredEnv('AGENTS_ENVIRONMENT_RELAY_URL');
const environments = getAgentsApiServices().environments;
const relay = createEnvironmentRelay({ environments, publicURL: () => endpoint, files: async (identity, harnessKey, operation, signal) => codexEnvironmentFiles({
  registryURL: endpoint, environmentId: identity.environmentId, harnessKey,
  workspace: await environments.workspaceDirectory(identity.ownerId, identity.environmentId), operation, signal,
}) });
relay.server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
