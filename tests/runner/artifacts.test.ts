import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localArtifactPaths, prepareArtifactDirectory } from '../../src/runner/artifacts.js';

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rat-local-artifacts-'));
  workspaces.push(path);
  return path;
}

describe('local artifact discovery', () => {
  it('creates the local output directory and preserves existing nested output', async () => {
    const root = await workspace();
    await expect(localArtifactPaths(root)).resolves.toEqual([]);
    const directory = await prepareArtifactDirectory(root);
    await mkdir(join(directory, 'screens'));
    await writeFile(join(directory, 'screens/home.png'), 'image');
    await writeFile(join(directory, 'answer.txt'), 'answer');
    await expect(localArtifactPaths(root)).resolves.toEqual(['answer.txt', 'screens/home.png']);
    await expect(localArtifactPaths(root)).resolves.toEqual(['answer.txt', 'screens/home.png']);
  });

  it('rejects symbolic links instead of following output outside its directory', async () => {
    const root = await workspace();
    const directory = await prepareArtifactDirectory(root);
    await writeFile(join(root, 'outside.txt'), 'private');
    await symlink(join(root, 'outside.txt'), join(directory, 'leak.txt'));
    await expect(localArtifactPaths(root)).rejects.toThrow('cannot be a symbolic link');
  });

  it('rejects invalid local output paths before exposing them', async () => {
    const root = await workspace();
    const directory = await prepareArtifactDirectory(root);
    await writeFile(join(directory, 'invalid\nname'), 'output');
    await expect(localArtifactPaths(root)).rejects.toThrow('invalid artifact path');
  });
});
