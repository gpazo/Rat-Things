import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { prepareHostedEnvironment } from '../../src/runner/hosted-environment.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

it('keeps native setup databases on worker-local storage outside the durable home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-setup-storage-'));
  const home = join(root, 'durable-home');
  const sqlite = join(root, 'worker-local');
  const workspace = join(root, 'workspace');
  await mkdir(home); await mkdir(workspace);
  try {
    const configuration = { network: { access: 'disabled' as const }, setup_commands: [{ command: 'true', cwd: workspace }] };
    const environment = { ...publicTemplate(configuration, { id: 'environment', created_at: 1, updated_at: 1 }), type: 'openai_hosted' as const, files: [], skills: [] };
    const launch = { sessionId: 'session', turnId: 'bootstrap', input: [], environment, hostedConfiguration: configuration, agent: sessionAgent({ model: 'fixture' }, 'agent', 1) };
    const plan = planCodexLaunch({ version: '1', prompt: '' }, workspace, 20_000, {
      CODEX_BINARY: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), CODEX_AUTH_MODE: 'chatgpt',
      PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: sqlite,
    });
    const prepared = await prepareHostedEnvironment({ launch, workspace, plan, artifacts: { getBytes: async () => new Uint8Array() }, stateDirectory: join(root, 'host') });
    expect(prepared.sandbox).toBeDefined();
    expect((await readdir(sqlite)).some(name => name.endsWith('.sqlite'))).toBe(true);
    expect((await readdir(home)).some(name => name.endsWith('.sqlite'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 30_000);
