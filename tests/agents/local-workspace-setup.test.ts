import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { localWorkspaceIdentity, type LocalWorkspaceIdentity } from '../../src/domain/local-workspace.js';
import { prepareLocalWorkspace } from '../../src/runner/local-workspace-setup.js';

const identity: LocalWorkspaceIdentity = { version: 1, sessionId: 'sess_test', generation: '85d548cf-5689-41cf-bdd4-b3dd8c7411ab', setupDigest: 'a'.repeat(64) };

it('requires a generation claim rather than a legacy preparation Boolean', () => {
  expect(() => localWorkspaceIdentity({ prepared: true })).toThrow('unverified');
  expect(localWorkspaceIdentity(identity)).toEqual(identity);
});

it('records intent before effects and resumes a completed workspace without repeating setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-setup-'));
  const effects: string[] = [];
  const prepare = async (preserve: boolean) => {
    const journal = JSON.parse(await readFile(join(directory, 'setup.json'), 'utf8'));
    effects.push(preserve ? 'restore root packages' : 'workspace setup');
    expect(journal.phase).toBe(preserve ? 'complete' : 'started');
  };
  const synchronize = async () => { effects.push('flush workspace'); };
  try {
    await prepareLocalWorkspace({ directory, intent: { kind: 'create', identity }, prepare, synchronize });
    await prepareLocalWorkspace({ directory, intent: { kind: 'resume', identity }, prepare, synchronize });
    expect(effects).toEqual(['workspace setup', 'flush workspace', 'restore root packages']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['setup', 'flush'])('blocks retry after interrupted %s without replaying effects', async phase => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-setup-'));
  const prepare = vi.fn(async () => { if (phase === 'setup') throw new Error('injected setup crash'); });
  const synchronize = vi.fn(async () => { if (phase === 'flush') throw new Error('injected flush crash'); });
  try {
    await expect(prepareLocalWorkspace({ directory, intent: { kind: 'create', identity }, prepare, synchronize })).rejects.toThrow('injected');
    for (let attempt = 0; attempt < 2; attempt++) await expect(prepareLocalWorkspace({ directory, intent: { kind: 'resume', identity }, prepare, synchronize })).rejects.toThrow('interrupted');
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects missing, mismatched and linked setup receipts before effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-setup-'));
  const prepare = vi.fn(async () => {}), synchronize = vi.fn(async () => {});
  try {
    await expect(prepareLocalWorkspace({ directory, intent: { kind: 'resume', identity }, prepare, synchronize })).rejects.toThrow('does not match');
    expect(prepare).not.toHaveBeenCalled();
    await prepareLocalWorkspace({ directory, intent: { kind: 'create', identity }, prepare, synchronize });
    prepare.mockClear();
    await expect(prepareLocalWorkspace({ directory, intent: { kind: 'resume', identity: { ...identity, setupDigest: 'b'.repeat(64) } }, prepare, synchronize })).rejects.toThrow('does not match');
    const linked = join(directory, 'linked');
    await symlink(directory, linked);
    await expect(prepareLocalWorkspace({ directory: linked, intent: { kind: 'resume', identity }, prepare, synchronize })).rejects.toThrow('private');
    expect(prepare).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([
  ['create', { phase: 'complete', identity }, 'A new local workspace already has setup state.'],
  ['create', { phase: 'started', identity: { prepared: true } }, 'A new local workspace already has setup state.'],
  ['resume', { phase: 'started', identity }, 'Local setup was interrupted. Its effects are uncertain; start a new Session without replaying setup.'],
  ['resume', { phase: 'unknown', identity }, 'Local setup was interrupted. Its effects are uncertain; start a new Session without replaying setup.'],
  ['resume', { phase: 'complete', identity: { ...identity, setupDigest: 'b'.repeat(64) } }, 'The saved workspace does not match this Session. Retain its files and start a new Session.'],
] as const)('preserves a rejected %s setup receipt without invoking effects: %j', async (kind, journal, message) => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-setup-contract-'));
  const path = join(directory, 'setup.json');
  const bytes = JSON.stringify(journal);
  const prepare = vi.fn(async () => {}), synchronize = vi.fn(async () => {});
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(prepareLocalWorkspace({ directory, intent: { kind, identity }, prepare, synchronize })).rejects.toThrow(message);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(prepare).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
