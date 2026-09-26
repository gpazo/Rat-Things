import { chown, lstat, mkdir, readFile, stat, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionLaunch } from '../domain/session-execution.js';
import { capabilityArchive } from '../domain/capability-archive.js';
import { decodeBase64, workspacePath } from '../domain/environment-planning.js';
import type { ArtifactStore } from '../core/ports.js';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import type { CodexLaunchPlan } from './agent-planning.js';
import { runProcess } from './process.js';
import { hostedCodexArguments, hostedProcessEnvironment } from './hosted-environment-planning.js';
import type { SessionEnvironmentCredentialsRuntime } from './session-environment-credentials.js';
import type { ManagedSandboxGeneration } from '../core/managed-environment-planning.js';
import { resetPersistentWorkspace } from './workspace.js';

/** Map a private persistent directory to the standard workspace path before guest code starts. */
export async function bindHostedWorkspace(workspace: string, visible = '/workspace'): Promise<void> {
  if (resolve(workspace) === resolve(visible)) return;
  const existing = await lstat(visible).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const source = await stat(workspace);
  if (existing?.isDirectory() && existing.dev === source.dev && existing.ino === source.ino) return;
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Managed workspace mountpoint is invalid');
  if (!existing) await mkdir(visible, { recursive: true });
  const mounted = await runProcess('mount', ['--bind', workspace, visible], { cwd: '/', timeoutMs: 30_000 });
  if (mounted.exitCode !== 0) throw new Error('Managed workspace mount failed');
}

export async function prepareHostedEnvironment(options: {
  launch: SessionLaunch; workspace: string; plan: CodexLaunchPlan;
  artifacts: Pick<ArtifactStore, 'getBytes'>; signal?: AbortSignal;
  stateDirectory: string; previouslyPrepared?: boolean;
  credentials?: SessionEnvironmentCredentialsRuntime;
  afterWorkspaceReset?: () => Promise<void>;
}): Promise<{ launch: SessionLaunch; sandbox?: ManagedSandboxGeneration }> {
  const { launch, workspace, plan, artifacts, signal } = options;
  if (launch.environment.type !== 'openai_hosted' || !launch.hostedConfiguration) return { launch };
  const configuration = launch.hostedConfiguration;
  const roots = [...launch.environment.capability_directories];
  const inline = [
    ...(configuration.plugins ?? []).map((plugin) => ({ ...plugin, kind: 'plugin' as const })),
    ...(configuration.skills ?? []).flatMap((skill) => skill.type === 'inline' ? [{ ...skill, kind: 'skill' as const }] : []),
  ].map((capability) => ({ ...capability, archive: capabilityArchive([{ path: 'capability.zip', data: decodeBase64(capability.source.data, 'source.data') }], capability.kind) }));
  const stored = await Promise.all((launch.hostedSkills ?? []).map(async (skill) => ({
    kind: 'skill' as const, name: skill.name, description: skill.description,
    archive: capabilityArchive([{ path: 'capability.zip', data: await artifacts.getBytes(skill.content) }], 'skill', 'stored'),
  })));
  const capabilities = [...inline, ...stored].map((capability) => {
    if (capability.archive.name !== capability.name || capability.archive.description !== capability.description) throw new Error('Capability archive metadata does not match its declaration');
    return { ...capability, root: `/workspace/.capabilities/${capability.kind}s/${capability.archive.name}` };
  });
  roots.push(...capabilities.map((capability) => capability.root));
  const result: SessionLaunch = { ...launch, environment: { ...launch.environment, capability_directories: [...new Set(roots)] } };
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await lstat(options.stateDirectory);
  if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink() || stateDirectory.uid !== process.getuid?.() || (stateDirectory.mode & 0o077) !== 0) throw new Error('Managed setup state is not private to the host');
  const marker = join(options.stateDirectory, `${launch.environment.id}.json`);
  const digest = createHash('sha256').update(JSON.stringify({ configuration, files: launch.hostedFiles, skills: launch.hostedSkills })).digest('hex');
  const markerState = await lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (markerState && (!markerState.isFile() || markerState.isSymbolicLink() || markerState.uid !== stateDirectory.uid || (markerState.mode & 0o077) !== 0 || markerState.nlink !== 1)) throw new Error('Managed setup state is invalid');
  const previous = markerState ? hostedSetupMarker(await readFile(marker, 'utf8')) : undefined;
  if (previous?.digest === digest) return { launch: result, sandbox: previous.sandbox };
  if (previous !== undefined) throw new Error('A managed environment cannot change its setup configuration');
  const sandbox: ManagedSandboxGeneration = { id: randomUUID(), replaced: options.previouslyPrepared ?? false };
  if (sandbox.replaced) {
    const directory = await lstat(workspace);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Managed workspace is invalid');
    // Keep the directory inode so /workspace's bind mount stays valid. Old
    // files in durable storage are not a checkpoint for a replaced sandbox.
    await resetPersistentWorkspace(workspace, true);
    await options.afterWorkspaceReset?.();
  }
  const system = configuration.packages?.system ?? [];
  if (system.some((name) => !/^[A-Za-z0-9][A-Za-z0-9+._:=-]*$/.test(name) || name.endsWith('.rpm'))) throw new Error('System packages must be signed repository package names');
  if (system.length) {
    const installed = await runProcess('dnf', ['install', '-y', '--setopt=gpgcheck=1', '--', ...system], { cwd: '/', env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeoutMs: 600_000, ...(signal ? { signal } : {}) });
    if (installed.exitCode !== 0) throw new Error('System package installation failed');
  }
  for (const file of configuration.files ?? []) {
    const reference = launch.hostedFiles?.find((candidate) => candidate.path === file.path)?.content;
    const data = file.type === 'inline' ? decodeBase64(file.data, 'files.data') : reference ? await artifacts.getBytes(reference) : undefined;
    if (!data) throw new Error('Prepared environment input is unavailable');
    await materialize(workspace, file.path, data, plan.identity);
  }
  for (const capability of capabilities) for (const file of capability.archive.files) await materialize(workspace, `${capability.root}/${file.path}`, file.data, plan.identity);
  await directory(workspace, '/workspace/outputs', plan.identity);
  await directory(workspace, '/workspace/.packages', plan.identity);
  const commands = [
    ...((configuration.packages?.npm ?? []).length ? [['npm', 'install', '--global', '--prefix', '/workspace/.packages', '--', ...configuration.packages!.npm!]] : []),
    ...((configuration.packages?.python ?? []).length ? [['python3', '-m', 'pip', 'install', '--target', '/workspace/.packages/python', '--', ...configuration.packages!.python!]] : []),
  ].map((command) => ({ command, cwd: '/workspace' }));
  commands.push(...(configuration.setup_commands ?? []).map((setup) => ({ command: ['bash', '-c', setup.command], cwd: setup.cwd ?? '/workspace' })));
  if (commands.length) {
    const rpc = new CodexRpcClient({ binary: plan.binary, binaryArguments: hostedCodexArguments(plan.binaryArguments, launch.environment.network, Boolean(options.credentials)), cwd: workspace,
      environment: { PATH: plan.environment.PATH, HOME: plan.environment.HOME, CODEX_HOME: plan.environment.CODEX_HOME, CODEX_API_KEY: 'setup-without-inference', ...options.credentials?.processEnvironment },
      ...(plan.identity ? { identity: plan.identity } : {}), ...(signal ? { signal } : {}),
    });
    try {
      await rpc.initialize();
      for (const [index, command] of commands.entries()) {
        const execution = await rpc.call('command/exec', { ...command, env: { ...hostedProcessEnvironment(configuration.env ?? {}, plan.environment.PATH), ...options.credentials?.shellEnvironment },
          permissionProfile: 'rat_managed', timeoutMs: 600_000, outputBytesCap: 64 * 1024,
        }, 610_000);
        if (typeof execution !== 'object' || execution === null || !('exitCode' in execution) || execution.exitCode !== 0) throw new Error(`Environment setup command ${index + 1} failed`);
      }
    } finally { await rpc.close(); }
  }
  await writeFile(marker, JSON.stringify({ digest, sandbox }), { flag: 'wx', mode: 0o600 });
  return { launch: result, sandbox };
}

function hostedSetupMarker(text: string): { digest: string; sandbox: ManagedSandboxGeneration } {
  // Existing private markers predate generation IDs. Their stable identifier
  // permits an in-place upgrade without inventing a sandbox replacement.
  if (/^[a-f0-9]{64}$/.test(text)) return { digest: text, sandbox: { id: `legacy-${text}`, replaced: false } };
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('digest' in value) || typeof value.digest !== 'string'
    || !('sandbox' in value) || typeof value.sandbox !== 'object' || value.sandbox === null
    || !('id' in value.sandbox) || typeof value.sandbox.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.sandbox.id)
    || !('replaced' in value.sandbox) || typeof value.sandbox.replaced !== 'boolean') throw new Error('Managed setup state is invalid');
  return { digest: value.digest, sandbox: { id: value.sandbox.id, replaced: value.sandbox.replaced } };
}

async function directory(root: string, path: string, identity?: { uid: number; gid: number }) {
  workspacePath(`${path}/placeholder`, 'path');
  const parts = path.slice('/workspace/'.length).split('/');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Environment paths cannot traverse links');
    if (!existing) { await mkdir(target, { mode: 0o700 }); if (identity) await chown(target, identity.uid, identity.gid); }
  }
}
async function materialize(root: string, path: string, data: Uint8Array, identity?: { uid: number; gid: number }) {
  workspacePath(path, 'path');
  const target = join(root, path.slice('/workspace/'.length));
  if (relative(root, target).startsWith('..')) throw new Error('Environment input is outside its workspace');
  if (dirname(path) !== '/workspace') await directory(root, dirname(path), identity);
  const temporary = join(dirname(target), `.input-${randomUUID()}`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    if (identity) await chown(temporary, identity.uid, identity.gid);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
