import { parentPort, workerData } from 'node:worker_threads';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { captureWorkspace, restoreWorkspace, checkpointHash, checkpointLimits } from './workspace-checkpoint.mjs';
const { action, file, workspace, sha256 } = workerData;
if (action === 'capture') {
  const bytes = await captureWorkspace(workspace);
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  parentPort.postMessage({ sha256: checkpointHash(bytes), bytes: bytes.length });
} else {
  const state = await lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.uid !== 0 || state.nlink !== 1 || (state.mode & 0o077) || state.size > checkpointLimits.archiveBytes) throw new Error('Checkpoint restore staging is invalid');
  await restoreWorkspace(workspace, await readFile(file), sha256, { uid: 10001, gid: 10001 });
  parentPort.postMessage({});
}
