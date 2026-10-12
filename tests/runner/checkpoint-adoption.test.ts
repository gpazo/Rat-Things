import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareHostedEnvironment } from '../../src/runner/hosted-environment.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { workspaceDigests, type WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';
import { sessionAgent } from '../../src/core/session-planning.js';

it('preserves modified workspace inputs and skips setup when a trusted checkpoint is adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-checkpoint-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'input.txt'), 'modified by the source agent');
    await writeFile(join(workspace, 'setup-count.txt'), '1');
    const configuration = { network: { access: 'disabled' as const }, files: [{ type: 'inline' as const, path: '/workspace/input.txt', data: Buffer.from('original input').toString('base64') }],
      setup_commands: [{ command: 'exit 99' }] };
    const environment = { ...publicTemplate(configuration, { id: 'environment', created_at: 1, updated_at: 1 }), type: 'openai_hosted' as const, files: [], skills: [] };
    const launch = { sessionId: 'session', turnId: 'turn', input: [], environment, hostedConfiguration: configuration, agent: sessionAgent({ model: 'fixture' }, 'agent', 1) };
    const checkpoint: WorkspaceCheckpoint = { id: 'checkpoint', sandboxId: randomUUID(), ...workspaceDigests(launch), source: { runId: 'old-run', generation: 'old-generation' },
      rootThreadId: 'root', lastRootTurnId: 'api-turn', lastNativeTurnId: 'native-turn', reason: 'hibernate', createdAt: 1 };
    const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'workspace-write', capabilities: { networkAccess: false } } }, workspace, 1000, { CODEX_AUTH_MODE: 'chatgpt' });
    const reset = vi.fn(async () => {});
    const options = { launch, workspace, plan: { ...plan, binary: '/not-a-real-native-binary' }, artifacts: { getBytes: async () => new Uint8Array() },
      stateDirectory: join(root, 'new-host'), previouslyPrepared: true, adoptedCheckpoint: checkpoint, afterWorkspaceReset: reset };
    const prepared = await prepareHostedEnvironment(options);
    expect(prepared.sandbox).toEqual({ id: checkpoint.sandboxId, replaced: false });
    expect(await readFile(join(workspace, 'input.txt'), 'utf8')).toBe('modified by the source agent');
    expect(await readFile(join(workspace, 'setup-count.txt'), 'utf8')).toBe('1');
    expect(reset).not.toHaveBeenCalled();
    expect((await prepareHostedEnvironment(options)).sandbox).toEqual(prepared.sandbox);
    await expect(prepareHostedEnvironment({ ...options, adoptedCheckpoint: { ...checkpoint, setupDigest: 'wrong' } })).rejects.toThrow('incompatible');
    await expect(prepareHostedEnvironment({ ...options, adoptedCheckpoint: { ...checkpoint, sandboxId: randomUUID() } })).rejects.toThrow('Local sandbox');
  } finally { await rm(root, { recursive: true, force: true }); }
});
