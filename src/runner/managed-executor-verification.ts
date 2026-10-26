import { chown, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { CodexLaunchPlan } from './agent-planning.js';
import { hostedCodexArguments } from './hosted-environment-planning.js';
import { verifyManagedSandbox } from './managed-sandbox.js';
import { verifyManagedCodexPolicy } from '../adapters/codex-managed-policy.js';

export async function verifyManagedExecutor(options: {
  plan: CodexLaunchPlan; workspace: string;
  network: Extract<SessionLaunch['environment'], { type: 'openai_hosted' }>['network'];
  credentialProxy: boolean; signal?: AbortSignal;
}): Promise<void> {
  const { plan } = options;
  const home = await mkdtemp(join(tmpdir(), 'rat-managed-verification-'));
  let rpc: CodexRpcClient | undefined;
  try {
    if (plan.identity) await chown(home, plan.identity.uid, plan.identity.gid);
    rpc = new CodexRpcClient({ startupPurpose: 'setup', binary: plan.binary, cwd: options.workspace,
      binaryArguments: hostedCodexArguments(['-c', 'features.plugins=false', 'app-server'], options.network, options.credentialProxy, options.workspace),
      environment: { PATH: plan.environment.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'sandbox-verification-no-inference' },
      ...(plan.identity ? { identity: plan.identity } : {}), ...(options.signal ? { signal: options.signal } : {}),
      onServerRequest: async () => { throw new Error('Sandbox verification cannot request approval'); },
    });
    await rpc.initialize();
    await verifyManagedCodexPolicy({ call: rpc.call.bind(rpc), policy: { workspace: options.workspace, network: options.network, credentialProxy: options.credentialProxy } });
    await verifyManagedSandbox({ call: rpc.call.bind(rpc), workspace: options.workspace, home, ...(plan.identity ? { identity: plan.identity } : {}) });
  } finally {
    try { await rpc?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
}
