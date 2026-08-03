import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CachedSecretReader } from '../../src/adapters/aws-runtime.js';
import { collectWorkspacePatch, prepareWorkspace } from '../../src/runner/workspace.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ephemeral workspace', () => {
  it('creates an empty baseline and captures untracked files in the patch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-workspace-'));
    const workspace = join(root, 'run-1');
    vi.stubEnv('WORKSPACE_ROOT', root);
    vi.stubEnv('RUN_AGENT_UID', '');
    vi.stubEnv('RUN_AGENT_GID', '');
    const secrets = { get: vi.fn() } as unknown as CachedSecretReader;

    try {
      await prepareWorkspace(undefined, workspace, secrets);
      await writeFile(join(workspace, 'result.txt'), 'created by agent\n');
      const patch = await collectWorkspacePatch(workspace);
      expect(patch?.toString('utf8')).toContain('diff --git a/result.txt b/result.txt');
      expect(patch?.toString('utf8')).toContain('+created by agent');
      expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('created by agent\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a workspace outside the configured root before touching it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'agent-runtime-outside-'));
    vi.stubEnv('WORKSPACE_ROOT', root);
    const secrets = { get: vi.fn() } as unknown as CachedSecretReader;
    try {
      await expect(prepareWorkspace(undefined, outside, secrets)).rejects.toThrow(
        `workspace must be below ${root}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
