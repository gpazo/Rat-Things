import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rpcClient } from './codex-protocol.js';
import { codexEnvironmentFiles } from '../../src/adapters/codex-environment-files.js';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createEnvironmentRelay } from '../../src/adapters/environment-relay.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { environmentToken, type EnvironmentCredentials } from '../../src/credentials/environment.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { MemoryAgentsStore } from './fixtures.js';

function fixture(clock?: { now(): number }) {
  const secrets = new Map<string, EnvironmentCredentials>();
  const store = new MemoryAgentsStore();
  const environments = new EnvironmentService({ store, ...(clock ? { clock } : {}), relayURL: 'https://relay.example', credentials: {
    create: async (ownerId, environmentId) => {
      secrets.set(environmentId, { executor: environmentToken({ ownerId, environmentId, role: 'executor' }, 'executor-secret'), harness: environmentToken({ ownerId, environmentId, role: 'harness' }, 'harness-secret') });
      return environmentId;
    },
    read: async (id) => secrets.get(id)!, revoke: async (id) => { secrets.delete(id); },
  } });
  return { environments, secrets };
}

describe('self-hosted execution relay', () => {
  it('expires waiting input after five minutes and never replays it on a late connection', async () => {
    let now = 100;
    const f = fixture({ now: () => now });
    const environment = await f.environments.prepare('alice', 'sess_1', { type: 'self_hosted', workspace_directory: '/workspace' });
    if (environment.type === 'none') throw new Error('Expected environment');
    await expect(f.environments.launchReference('alice', environment.id, 400)).rejects.toMatchObject({ status: 503 });
    now = 400;
    await expect(f.environments.launchReference('alice', environment.id, 400)).rejects.toMatchObject({ status: 408 });
    now = 401;
    const identity = { ownerId: 'alice', environmentId: environment.id, role: 'executor' as const };
    await f.environments.connection(identity, 'late-executor', true);
    await expect(f.environments.launchReference('alice', environment.id, 400)).rejects.toMatchObject({ code: 'environment_connection_timeout' });
    expect(await f.environments.launchReference('alice', environment.id, 701)).toBe(environment.id);
    now = 431;
    await f.environments.connection(identity, 'late-executor', true);
    expect(await f.environments.launchReference('alice', environment.id, 420)).toBe(environment.id);
  });

  it('scopes keys to an owner, environment, and connection role, and revokes retired environments', async () => {
    const f = fixture();
    const environment = await f.environments.prepare('alice', 'sess_1', { type: 'self_hosted', workspace_directory: '/workspace' });
    if (environment.type === 'none') throw new Error('Expected a self-hosted environment');
    parseAgentsContract('Environment', await f.environments.retrieve('alice', environment.id));
    const connection = await f.environments.executorConnection('alice', environment.id);
    await expect(f.environments.authenticate(connection.executor_key, environment.id, 'harness')).rejects.toMatchObject({ status: 401 });
    await expect(f.environments.authenticate(connection.executor_key, 'env_another', 'executor')).rejects.toMatchObject({ status: 401 });
    await expect(f.environments.retrieve('bob', environment.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.environments.authenticate(`${connection.executor_key}x`, environment.id, 'executor')).rejects.toMatchObject({ status: 401 });
    expect((await f.environments.authenticate(connection.executor_key, environment.id, 'executor')).ownerId).toBe('alice');
    await f.environments.retire('alice', environment.id);
    await expect(f.environments.authenticate(connection.executor_key, environment.id, 'executor')).rejects.toMatchObject({ status: 401 });
  });

  it('connects the stock Codex executor and harness through the encrypted relay without model calls', async () => {
    const f = fixture();
    const temporary = await mkdtemp(join(tmpdir(), 'rat-executor-conformance-'));
    const children: ChildProcessWithoutNullStreams[] = [];
    let address = '';
    const relay = createEnvironmentRelay({ environments: f.environments, publicURL: () => address });
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const bound = relay.server.address();
    if (!bound || typeof bound === 'string') throw new Error('Relay did not bind');
    address = `http://127.0.0.1:${bound.port}`;
    try {
      const environment = await f.environments.prepare('alice', 'sess_1', { type: 'self_hosted', workspace_directory: temporary });
      if (environment.type === 'none') throw new Error('Expected a self-hosted environment');
      const credentials = f.secrets.get(environment.id)!;
      const env = { PATH: process.env.PATH, HOME: temporary, CODEX_HOME: temporary, RUST_LOG: 'error', CODEX_API_KEY: credentials.executor };
      const executor = spawn((process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')), ['exec-server', '--remote', address, '--environment-id', environment.id], { env });
      children.push(executor);
      // Consume diagnostics so a child cannot block on an unread pipe. Never print connection keys.
      let diagnostic = '';
      executor.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-2000); });
      executor.stdout.resume();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await f.environments.retrieve('alice', environment.id)).status === 'connected') break;
        if (executor.exitCode !== null) throw new Error(`Executor exited: ${diagnostic.replaceAll(credentials.executor, '[redacted]')}`);
        await delay(50);
      }
      expect((await f.environments.retrieve('alice', environment.id)).status).toBe('connected');
      const fileOperation = { registryURL: address, environmentId: environment.id, harnessKey: credentials.harness, workspace: temporary, binary: (process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')) };
      expect(await codexEnvironmentFiles({ ...fileOperation, operation: { operation: 'write', path: '/workspace/answer.bin', data: 'AP+A' } })).toEqual({ path: '/workspace/answer.bin', size_bytes: 3 });
      expect(await codexEnvironmentFiles({ ...fileOperation, operation: { operation: 'list', path: '/workspace' } })).toEqual(expect.arrayContaining([{ path: '/workspace/answer.bin', size_bytes: 3 }]));
      expect(await codexEnvironmentFiles({ ...fileOperation, operation: { operation: 'read', path: '/workspace/answer.bin', offset: 1, length: 2 } })).toMatchObject({ data: '/4A=', size_bytes: 3 });
      expect(await readFile(join(temporary, 'answer.bin'))).toEqual(Buffer.from([0, 255, 128]));
      const uploadId = randomUUID();
      const large = Buffer.alloc(2 * 1024 * 1024, 197);
      const sha256 = createHash('sha256').update(large).digest('hex');
      for (let offset = 0; offset < large.length; offset += 1024 * 1024) {
        const operation = { operation: 'write_chunk' as const, path: '/workspace/large.bin', uploadId, offset, size: large.length, sha256, data: large.subarray(offset, offset + 1024 * 1024).toString('base64') };
        await codexEnvironmentFiles({ ...fileOperation, operation });
        if (offset === 0) {
          // A retry replaces only the same chunk; no partial destination is published.
          await codexEnvironmentFiles({ ...fileOperation, operation });
          await expect(readFile(join(temporary, 'large.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      expect((await readFile(join(temporary, 'large.bin'))).equals(large)).toBe(true);
      await symlink(join(temporary, 'answer.bin'), join(temporary, 'link.bin'));
      await expect(codexEnvironmentFiles({ ...fileOperation, operation: { operation: 'write', path: '/workspace/link.bin', data: '' } })).rejects.toThrow();
      expect(await readFile(join(temporary, 'answer.bin'))).toEqual(Buffer.from([0, 255, 128]));
      const harness = spawn((process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')), ['app-server'], { env: {
        ...env, CODEX_API_KEY: 'unused-for-this-test',
        CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: address,
        CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: environment.id,
        CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: credentials.harness,
      } });
      children.push(harness);
      harness.stderr.resume();
      const rpc = rpcClient(harness);
      await rpc.call('initialize', { clientInfo: { name: 'rat-conformance', version: '1' }, capabilities: { experimentalApi: true } });
      harness.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      let status: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = await rpc.call('environment/status', { environmentId: 'remote' });
        if (typeof status === 'object' && status !== null && 'status' in status && status.status === 'ready') break;
        await delay(50);
      }
      expect(status).toMatchObject({ status: 'ready' });
      const started = await rpc.call('thread/start', {
        cwd: temporary, model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only',
        environments: [], ephemeral: true, selectedCapabilityRoots: [],
      }) as { thread: { id: string } };
      await rpc.call('thread/inject_items', { threadId: started.thread.id, items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Previous input' }] },
        { type: 'function_call', name: 'lookup', call_id: 'call_saved', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_saved', output: '' },
        { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Previous answer' }] },
      ] });
      rpc.close();
    } finally {
      for (const child of children) {
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await Promise.race([once(child, 'exit'), delay(1000)]);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      }
      await relay.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 20_000);
});
