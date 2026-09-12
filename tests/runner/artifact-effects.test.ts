import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactCatalog, PublishedArtifact } from '../../src/domain/contracts.js';
import {
  artifactPrompt, emptyArtifactCatalog, publishArtifactCatalog, restoreArtifactCatalog,
} from '../../src/runner/artifacts.js';
import { MemoryArtifacts } from './artifact-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'rat-artifact-effects-'));
  roots.push(root);
  const directory = join(root, '.rat-things/artifacts');
  await mkdir(directory, { recursive: true });
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(directory, path), bytes);
  return { root, directory };
}

function publishInput(root: string, store = new MemoryArtifacts(), files: PublishedArtifact[] = []) {
  return {
    workspace: root, artifacts: store, previous: { version: '1', files } as ArtifactCatalog,
    ownerId: 'owner-1', runId: 'run-1', createdAt: '2026-08-14T12:00:00.000Z',
  };
}

describe('artifact publication effects', () => {
  it('validates the prior catalog before preparing directories', async () => {
    const { root } = await workspace({});
    const missingWorkspace = join(root, 'uncreated');
    const input = publishInput(missingWorkspace);
    input.previous = { version: 'invalid', files: [] } as unknown as ArtifactCatalog;

    await expect(publishArtifactCatalog(input)).rejects.toThrow('version 1 file array');
    await expect(readdir(missingWorkspace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(input.artifacts.puts).toEqual([]);
  });

  it('uploads one copy of matching bytes, reuses it in scan order, and sorts the returned catalog', async () => {
    const { root } = await workspace({ 'a.txt': 'shared', 'Z.txt': 'shared' });
    const input = publishInput(root);
    const events: string[] = [];
    const putStream = input.artifacts.putStream.bind(input.artifacts);
    const copy = input.artifacts.copy.bind(input.artifacts);
    input.artifacts.putStream = async (...args) => { events.push('upload'); return putStream(...args); };
    input.artifacts.copy = async (...args) => { events.push('copy'); return copy(...args); };

    const result = await publishArtifactCatalog(input);
    expect(events).toEqual(['upload', 'copy']);
    expect(result.map((file) => file.path)).toEqual(['a.txt', 'Z.txt']);
    expect(result[0]!.file).toEqual(result[1]!.file);
    expect(input.previous.files).toEqual([]);
  });

  it('retains prior metadata for unchanged files while passing detected media to storage', async () => {
    const { root } = await workspace({ 'same.txt': 'unchanged' });
    const store = new MemoryArtifacts();
    const first = await publishArtifactCatalog(publishInput(root, store));
    first[0]!.mediaType = 'application/custom';
    Object.freeze(first[0]);
    const before = structuredClone(first);
    const copy = vi.spyOn(store, 'copy');

    const result = await publishArtifactCatalog({ ...publishInput(root, store, first), runId: 'new-run', createdAt: '' });
    expect(copy).toHaveBeenCalledWith(first[0]!.file, first[0]!.file.key, 'text/plain; charset=utf-8');
    expect(result[0]).toEqual(first[0]);
    expect(result[0]).not.toBe(first[0]);
    expect(first).toEqual(before);
  });

  it('reuses a previous blob at a different path while assigning fresh provenance', async () => {
    const { root, directory } = await workspace({ 'old.txt': 'same bytes' });
    const store = new MemoryArtifacts();
    const first = await publishArtifactCatalog(publishInput(root, store));
    await rm(join(directory, 'old.txt'));
    await writeFile(join(directory, 'new.json'), 'same bytes');

    const result = await publishArtifactCatalog({ ...publishInput(root, store, first), runId: 'new-run', createdAt: '' });
    expect(store.puts).toHaveLength(1);
    expect(store.copies).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: 'new.json', mediaType: 'application/json', sourceRunId: 'new-run', createdAt: '' });
  });

  it('retains earlier writes when a later regular-file check fails', async () => {
    const { root, directory } = await workspace({ 'a.txt': 'first' });
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'aliased');
    await link(outside, join(directory, 'z.txt'));
    const input = publishInput(root);

    await expect(publishArtifactCatalog(input)).rejects.toThrow('artifact z.txt cannot be a hard link');
    expect(input.artifacts.puts).toHaveLength(1);
    expect([...input.artifacts.values.values()].map((value) => Buffer.from(value).toString())).toEqual(['first']);
  });

  it('rejects a symlink found during scanning before uploading any earlier file', async () => {
    const { root, directory } = await workspace({ 'a.txt': 'first' });
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'private');
    await symlink(outside, join(directory, 'z.txt'));
    const input = publishInput(root);

    await expect(publishArtifactCatalog(input)).rejects.toThrow('cannot be a symbolic link');
    expect(input.artifacts.puts).toEqual([]);
  });

  it('preserves the original storage failure and leaves earlier writes in place', async () => {
    const { root } = await workspace({ 'a.txt': 'first', 'b.txt': 'second' });
    const input = publishInput(root);
    const cause = new Error('upload unavailable');
    const put = input.artifacts.putStream.bind(input.artifacts);
    let writes = 0;
    input.artifacts.putStream = async (...args) => {
      if (++writes === 2) {
        for await (const _chunk of args[1]) { /* Consume without storing the failed upload. */ }
        throw cause;
      }
      return put(...args);
    };

    await expect(publishArtifactCatalog(input)).rejects.toBe(cause);
    expect(input.artifacts.puts).toHaveLength(1);
  });

  it('rejects a mismatched stored checksum before publishing later files', async () => {
    const { root } = await workspace({ 'a.txt': 'first', 'b.txt': 'second' });
    const input = publishInput(root);
    const put = input.artifacts.putStream.bind(input.artifacts);
    input.artifacts.putStream = async (...args) => ({ ...await put(...args), sha256: 'f'.repeat(64) });

    await expect(publishArtifactCatalog(input)).rejects.toThrow('artifact a.txt changed while it was being published');
    expect(input.artifacts.puts).toHaveLength(1);
  });

  it('keeps the environment lookup at the artifact-prompt boundary', () => {
    vi.stubEnv('AGENT_PUBLICATION_ENABLED', 'false');
    expect(artifactPrompt('prompt')).not.toContain('share.json');
    vi.stubEnv('AGENT_PUBLICATION_ENABLED', 'true');
    expect(artifactPrompt('prompt')).toContain('share.json');
    expect(artifactPrompt('prompt', false)).not.toContain('share.json');
  });
});

describe('artifact restoration effects', () => {
  it('keeps earlier restored files and removes a failed temporary file after a checksum mismatch', async () => {
    const { root, directory } = await workspace({ 'stale.txt': 'stale' });
    const store = new MemoryArtifacts();
    const files: PublishedArtifact[] = [];
    for (const path of ['a.txt', 'b.txt']) {
      const file = await store.putBytes(`source/${path}`, Buffer.from(path), 'text/plain');
      files.push({
        id: createHash('sha256').update(path).digest('hex').slice(0, 24), path,
        bytes: path.length, mediaType: 'text/plain', sourceRunId: 'run-1', createdAt: '2026-08-14T12:00:00.000Z', file,
      });
    }
    const read = store.getStream.bind(store);
    store.getStream = async (reference) => reference.key.endsWith('b.txt')
      ? (async function* () { yield Buffer.from('changed bytes'); })()
      : read(reference);

    await expect(restoreArtifactCatalog(root, { version: '1', files }, store)).rejects.toThrow('failed its checksum');
    expect(await readdir(directory)).toEqual(['a.txt']);
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a.txt');
  });

  it('does not clear existing files when the incoming catalog is invalid', async () => {
    const { root, directory } = await workspace({ 'stale.txt': 'preserve' });
    const invalid = { ...emptyArtifactCatalog(), version: 'invalid' } as unknown as ArtifactCatalog;
    await expect(restoreArtifactCatalog(root, invalid, new MemoryArtifacts())).rejects.toThrow('version 1 file array');
    expect(await readFile(join(directory, 'stale.txt'), 'utf8')).toBe('preserve');
  });
});
