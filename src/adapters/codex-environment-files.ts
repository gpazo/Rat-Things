import { mkdtemp, rm, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcClient } from './codex-rpc.js';
import environmentFileWorkerSource from './environment-file-worker-source.json' with { type: 'json' };
import type { EnvironmentFileOperation } from '../core/environment-file-ports.js';

/** Files travel over the existing authenticated Noise executor connection. No inference is involved. */
export async function codexEnvironmentFiles(options: {
  registryURL?: string; environmentId?: string; harnessKey?: string; workspace: string;
  operation: EnvironmentFileOperation;
  binary?: string; signal?: AbortSignal;
  identity?: { uid: number; gid: number };
}): Promise<unknown> {
  const home = await mkdtemp(join(tmpdir(), 'rat-environment-files-'));
  if (options.identity) await chown(home, options.identity.uid, options.identity.gid);
  const remote = options.registryURL !== undefined;
  if (remote && (!options.environmentId || !options.harnessKey)) throw new Error('Remote file operation requires an environment credential');
  const rpc = new CodexRpcClient({ binary: options.binary ?? 'codex', cwd: home, environment: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'environment-operations-no-inference',
    ...(remote ? { CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: options.registryURL,
      CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: options.environmentId,
      CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: options.harnessKey } : {}),
  }, ...(options.signal ? { signal: options.signal } : {}), ...(options.identity ? { identity: options.identity } : {}) });
  try {
    await rpc.initialize();
    const started = await rpc.call('thread/start', {
      cwd: options.workspace, environments: [{ environmentId: remote ? 'remote' : 'local', cwd: options.workspace }], ephemeral: true,
      approvalPolicy: 'never', sandbox: 'danger-full-access', selectedCapabilityRoots: [],
      config: { mcp_servers: { rat_workspace: {
        command: 'node', args: ['--input-type=module', '-e', environmentFileWorkerSource], cwd: options.workspace,
        environment_id: remote ? 'remote' : 'local', required: true, enabled_tools: ['files'], default_tools_approval_mode: 'approve',
      } } },
    });
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== 'string') throw new Error('Environment operation returned no thread');
    const result = await rpc.call('mcpServer/tool/call', { threadId: started.thread.id, server: 'rat_workspace', tool: 'files', arguments: options.operation });
    if (!record(result) || result.isError || !Array.isArray(result.content)) throw new Error('Environment file operation failed');
    const text = result.content.find((part: unknown) => record(part) && part.type === 'text');
    if (!record(text) || typeof text.text !== 'string') throw new Error('Environment file response is invalid');
    return JSON.parse(text.text) as unknown;
  } finally { await rpc.close(); await rm(home, { recursive: true, force: true }); }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
