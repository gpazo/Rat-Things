import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { localSetupAction, type LocalSetupJournal, type LocalWorkspaceIntent } from '../domain/local-workspace.js';

export async function prepareLocalWorkspace(options: {
  intent: LocalWorkspaceIntent;
  directory: string;
  prepare: (preserve: boolean) => Promise<void>;
  synchronize: () => Promise<void>;
}): Promise<void> {
  if (options.intent.kind === 'create') await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || options.intent.kind === 'resume' && directory.mode & 0o077) {
    throw new Error('Local setup state must be private to the supervisor.');
  }
  if (options.intent.kind === 'create') await chmod(options.directory, 0o700);
  const path = join(options.directory, 'setup.json');
  let journal: unknown;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = await file.stat();
      if (!state.isFile() || state.uid !== directory.uid || state.mode & 0o077 || state.nlink !== 1 || state.size > 4096) throw new Error('Local setup state is invalid.');
      journal = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const action = localSetupAction(options.intent, journal);
  if (action === 'preserve') { await options.prepare(true); return; }
  await durableWrite(path, { phase: 'started', identity: options.intent.identity });
  await syncDirectory(options.directory);
  await options.prepare(false);
  await options.synchronize();
  const completed = join(options.directory, `complete-${randomUUID()}.json`);
  await durableWrite(completed, { phase: 'complete', identity: options.intent.identity });
  await rename(completed, path);
  await syncDirectory(options.directory);
}

async function durableWrite(path: string, value: LocalSetupJournal) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
