import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createAgentsClient } from '../../src/agents-client.js';
import { AgentsForkDemoBackend } from './backend.js';
import { ForkDemoController } from './controller.js';
import { allThemes } from './directions.js';

// A durable, explicitly opted-in capture run. Selection happens after reviewing saved artifacts.
const [action, key, ...extra] = process.argv.slice(2).filter(arg => arg !== '--live');
if (!process.argv.includes('--live') || !['prepare', 'choose', 'cleanup'].includes(action ?? '') || extra.length ||
  (action === 'choose' ? !key : key !== undefined))
  throw new Error('Use --live prepare, --live choose <direction>, or --live cleanup.');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const directory = resolve(required('FORK_DEMO_CAPTURE_DIR'));
const baseURL = required('RAT_THINGS_AGENTS_API_URL');
const region = required('AWS_REGION');
const api = createAgentsClient({ baseURL, region });
const backend = new AgentsForkDemoBackend(api, required('AGENT_MODEL'));
const controller = new ForkDemoController(backend, join(directory, 'state.json'), `${baseURL}|${region}`, allThemes);
await mkdir(directory, { recursive: true, mode: 0o700 });
await controller.restore();
const proofFile = join(directory, 'proof.json');
const proof = JSON.parse(await readFile(proofFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
})) as Record<string, unknown>;
const saveProof = async () => writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
async function perform(operation: string, choice?: string) {
  await controller.action(operation, choice);
  if (controller.state.error) throw new Error(controller.state.error);
}
async function status(operation: () => Promise<unknown>) {
  try { await operation(); return 200; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return 404;
    throw error;
  }
}
const progress = setInterval(() => console.log(controller.state.status), 15_000);
try {
  if (action === 'prepare') {
    if (controller.state.phase === 'empty') await perform('start');
    if (controller.state.phase === 'ready') await perform('fork');
    if (controller.state.phase !== 'comparing') throw new Error('Capture is not ready to compare. Inspect the inventory and clean up an interrupted run.');
    const branches = [];
    for (const branch of controller.state.branches) {
      if (!branch.html) throw new Error(`Missing ${branch.key} artifact.`);
      await writeFile(join(directory, `${branch.key}.html`), branch.html);
      branches.push({ key: branch.key, sessionId: branch.sessionId, sha256: createHash('sha256').update(branch.html).digest('hex'), bytes: Buffer.byteLength(branch.html) });
    }
    Object.assign(proof, { capturedAt: new Date().toISOString(), source: controller.state.source, agentId: controller.state.agentId, branches });
  } else if (action === 'choose') {
    await perform('choose', key);
    const sourceId = controller.state.source!.sessionId;
    const sourceStatus = await status(() => api.beta.agents.sessions.retrieve(sourceId));
    const branches = [];
    for (const branch of controller.state.branches) {
      const actual = await status(() => api.beta.agents.sessions.retrieve(branch.sessionId!));
      if (actual !== (branch.key === key ? 200 : 404)) throw new Error(`Unexpected post-selection status for ${branch.key}: ${actual}`);
      branches.push({ key: branch.key, status: actual });
    }
    if (sourceStatus !== 200) throw new Error('Original Session was not retained.');
    proof.selection = { winner: key, sourceStatus, branches, checkedAt: new Date().toISOString() };
  } else {
    const ids = [...controller.state.branches.map(branch => branch.sessionId), controller.state.source?.sessionId].filter((id): id is string => Boolean(id));
    const agentId = controller.state.agentId;
    await perform('cleanup');
    const sessions = [];
    for (const id of ids) {
      const actual = await status(() => api.beta.agents.sessions.retrieve(id));
      if (actual !== 404) throw new Error(`Session ${id} was not cleaned up.`);
      sessions.push({ id, missing: true });
    }
    const agentMissing = agentId ? (await status(() => api.beta.agents.retrieve(agentId))) === 404 : true;
    if (!agentMissing) throw new Error('Agent was not cleaned up.');
    proof.cleanup = { sessions, agentMissing, checkedAt: new Date().toISOString() };
  }
  await saveProof();
  console.log(`${action} complete; evidence saved in ${directory}`);
} finally {
  clearInterval(progress);
}
