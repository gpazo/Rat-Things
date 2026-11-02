import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { repositoryBaseFetchArguments, repositoryCheckoutCommands, trustedGitEnvironment } from '../../src/runner/workspace-planning.js';

it('checks out the requested head after fetching a different base under the trusted UID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-fetch-head-'));
  const source = join(root, 'source');
  const work = join(root, 'workspace');
  const git = async (args: string[]) => (await promisify(execFile)('git', args, { env: trustedGitEnvironment(process.env) })).stdout.trim();
  try {
    await git(['init', '--quiet', '--initial-branch=main', source]);
    await git(['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
    const base = await git(['-C', source, 'rev-parse', 'HEAD']);
    await git(['-C', source, 'checkout', '--quiet', '-b', 'feature']);
    await git(['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'head']);
    const head = await git(['-C', source, 'rev-parse', 'HEAD']);
    await git(['init', '--quiet', work]);
    await git(['-C', work, 'remote', 'add', 'origin', source]);
    const [fetch, checkout] = repositoryCheckoutCommands(work, 'feature');
    await git(fetch);
    await git(repositoryBaseFetchArguments(work, 'main')!);
    await git(checkout);
    expect(await git(['-C', work, 'rev-parse', 'HEAD'])).toBe(head);
    expect(await git(['-C', work, 'rev-parse', 'refs/remotes/origin/main'])).toBe(base);
  } finally { await rm(root, { recursive: true, force: true }); }
});
