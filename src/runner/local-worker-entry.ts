import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, chown } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createEnvironmentRelay } from '../adapters/environment-relay.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { LocalWorkerConfiguration } from '../core/local-runtime-ports.js';
import { workspaceDigests } from '../domain/workspace-checkpoint.js';
import { prepareHostedEnvironment } from './hosted-environment.js';
import { planCodexLaunch } from './agent-planning.js';
import { prepareLocalWorkspace } from './local-workspace-setup.js';
import { localWorkspaceIdentity } from '../domain/local-workspace.js';

let phase = 'configuration';
async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Local worker requires the isolated Linux image');
  const lines = createInterface({ input: process.stdin });
  const input = await new Promise<LocalWorkerConfiguration>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker configuration timed out')), 30_000);
    lines.once('line', line => { clearTimeout(timer); lines.close(); try { resolve(JSON.parse(line) as LocalWorkerConfiguration); } catch { reject(new Error('Invalid worker configuration')); } });
  });
  const endpoint = new URL(input.publicURL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !/^env_[a-zA-Z0-9]+$/.test(input.environmentId)) throw new Error('Invalid local worker endpoint');
  phase = 'workspace';
  const identity = localWorkspaceIdentity(input.workspace?.identity);
  if (!['create', 'resume'].includes(input.workspace.kind) || identity.sessionId !== input.sessionId || identity.setupDigest !== workspaceDigests(input.launch).setupDigest) throw new Error('Invalid workspace claim');
  for (const path of ['/workspace', '/home/agent/.codex']) { await mkdir(path, { recursive: true, mode: 0o700 }); await chown(path, 10001, 10001); }
  const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'workspace-write' } }, '/workspace', 600_000, {
    PATH: process.env.PATH, HOME: '/home/agent', CODEX_HOME: '/home/agent/.codex', CODEX_BINARY: '/opt/codex-runtime/bin/codex',
    CODEX_AUTH_MODE: 'chatgpt', RUN_AGENT_UID: '10001', RUN_AGENT_GID: '10001',
  });
  phase = 'setup';
  await prepareLocalWorkspace({ intent: input.workspace, directory: '/var/lib/rat-things/workspace',
    prepare: async preserve => { await prepareHostedEnvironment({ launch: input.launch, workspace: '/workspace', plan, stateDirectory: '/tmp/rat-hosted-state',
      ...(preserve ? { forkSetupDigest: identity.setupDigest } : {}),
      artifacts: { getBytes: async () => { throw new Error('Stored inputs must be materialized before local launch'); } },
    }); },
    synchronize: async () => { await promisify(execFile)('sync', ['-f', '/workspace'], { timeout: 30_000 }); },
  });
  phase = 'transport';
  const relay = createEnvironmentRelay({
    healthEnvironmentId: input.environmentId,
    publicURL: role => role === 'executor' ? 'http://127.0.0.1:3211' : input.publicURL,
    environments: {
      async authenticate(token, id, role) {
        const expected = role === 'executor' ? input.executorKey : input.harnessKey;
        const bytes = Buffer.from(token); const match = Buffer.from(expected);
        if (id !== input.environmentId || bytes.length !== match.length || !timingSafeEqual(bytes, match)) throw new AgentsApiError(403, 'Invalid environment credential');
        return { ownerId: input.ownerId, environmentId: id, role };
      },
      async connection(_identity, _registration, connected) {
        if (connected) process.stdout.write('{"status":"ready"}\n');
        else void stop(1);
      },
    },
  });
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(3211, '0.0.0.0', resolve); });
  phase = 'executor';
  const executor = spawn('/opt/codex-runtime/bin/codex', ['exec-server', '--remote', 'http://127.0.0.1:3211', '--environment-id', input.environmentId], {
    uid: 10001, gid: 10001, cwd: '/workspace', stdio: ['ignore', 'ignore', 'ignore'],
    env: { PATH: process.env.PATH, HOME: '/home/agent', CODEX_HOME: '/home/agent/.codex', CODEX_API_KEY: input.executorKey },
  });
  let stopping = false;
  const stop = async (code: number) => { if (stopping) return; stopping = true; executor.kill('SIGTERM'); await relay.close(); process.exit(code); };
  process.once('SIGTERM', () => { void stop(0); }); process.once('SIGINT', () => { void stop(0); });
  executor.once('error', () => { void stop(1); }); executor.once('exit', () => { void stop(1); });
}

void main().catch(() => { process.stderr.write(`Local worker failed during ${phase}.\n`); process.exitCode = 1; });
