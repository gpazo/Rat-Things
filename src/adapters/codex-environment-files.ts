import { mkdtemp, rm, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcClient } from './codex-rpc.js';
import environmentFileWorkerSource from './environment-file-worker-source.json' with { type: 'json' };
import { isolatedCodexArguments } from '../domain/local-codex-arguments.js';
import type { EnvironmentFileOperation } from '../core/environment-file-ports.js';
import type { ManagedCodexPolicy } from '../domain/codex-managed-policy.js';
import { verifyManagedCodexPolicy } from './codex-managed-policy.js';

export class EnvironmentFilesCleanupUnconfirmedError extends Error {}

/** Files travel over the existing authenticated Noise executor connection. No inference is involved. */
export async function codexEnvironmentFiles(options: {
  registryURL?: string; environmentId?: string; harnessKey?: string; workspace: string;
  operation: EnvironmentFileOperation | readonly EnvironmentFileOperation[];
  binary?: string; signal?: AbortSignal;
  managed?: { binaryArguments: string[]; policy: ManagedCodexPolicy };
  environment?: Readonly<NodeJS.ProcessEnv>;
  temporaryHomeParent?: string;
  identity?: { uid: number; gid: number };
}): Promise<unknown> {
  const remote = options.registryURL !== undefined;
  if (remote && (!options.environmentId || !options.harnessKey)) throw new Error('Remote file operation requires an environment credential');
  options.signal?.throwIfAborted();
  const home = await mkdtemp(join(options.temporaryHomeParent ?? tmpdir(), 'rat-environment-files-'));
  if (options.identity) await chown(home, options.identity.uid, options.identity.gid);
  const environment = options.environment ?? process.env;
  const rpc = new CodexRpcClient({ binary: options.binary ?? 'codex', binaryArguments: options.managed?.binaryArguments ?? isolatedCodexArguments(['-c', 'cli_auth_credentials_store="file"', 'app-server']), cwd: home, environment: {
    PATH: environment.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: 'off',
    SSL_CERT_FILE: environment.SSL_CERT_FILE,
    ...(remote ? { CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: options.registryURL,
      CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: options.environmentId,
      CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: options.harnessKey } : {}),
  }, ...(options.signal ? { signal: options.signal } : {}), ...(options.identity ? { identity: options.identity } : {}) });
  try {
    await rpc.initialize();
    if (options.managed) await verifyManagedCodexPolicy({ call: rpc.call.bind(rpc), policy: options.managed.policy });
    const started = await rpc.call('thread/start', {
      cwd: options.workspace, environments: [{ environmentId: remote ? 'remote' : 'local', cwd: options.workspace }], ephemeral: true,
      approvalPolicy: 'never', ...(options.managed ? { permissions: 'rat_managed' } : { sandbox: 'danger-full-access' }), selectedCapabilityRoots: [],
      config: { mcp_servers: { rat_workspace: {
        command: 'node', args: ['--input-type=module', '-e', environmentFileWorkerSource], cwd: options.workspace,
        environment_id: remote ? 'remote' : 'local', required: true, enabled_tools: ['files'], default_tools_approval_mode: 'approve',
      } } },
    });
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== 'string') throw new Error('Environment operation returned no thread');
    const operations = Array.isArray(options.operation) ? options.operation : [options.operation];
    if (operations.length > 16) throw new Error('Too many environment file operations');
    const results: unknown[] = [];
    for (const operation of operations) {
      options.signal?.throwIfAborted();
      const result = await rpc.call('mcpServer/tool/call', { threadId: started.thread.id, server: 'rat_workspace', tool: 'files', arguments: operation });
      if (!record(result) || result.isError || !Array.isArray(result.content)) throw new Error('Environment file operation failed');
      const text = result.content.find((part: unknown) => record(part) && part.type === 'text');
      if (!record(text) || typeof text.text !== 'string') throw new Error('Environment file response is invalid');
      results.push(JSON.parse(text.text) as unknown);
    }
    return Array.isArray(options.operation) ? results : results[0];
  } finally { await confirmedClose(rpc); await rm(home, { recursive: true, force: true }); }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function confirmedClose(rpc: CodexRpcClient): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([rpc.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new EnvironmentFilesCleanupUnconfirmedError('Environment command process exit is unconfirmed')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
