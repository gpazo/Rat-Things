import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, chmod, chown, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserCommand, browserFrame, SharedBrowserActionError, type BrowserCommand, type BrowserFrame } from '../domain/shared-browser.js';
import { hostedCodexArguments } from './hosted-environment-planning.js';
import type { ManagedCodexPolicy } from '../domain/codex-managed-policy.js';
import source from './shared-browser-worker-source.json' with { type: 'json' };

/** Rat Things owns this lifetime. MCP and the UI are clients, not browser owners. */
export async function startSharedBrowser(options: {
  directory: string; network: ManagedCodexPolicy['network']; codexBinary: string;
  identity: { uid: number; gid: number }; environment: NodeJS.ProcessEnv;
  socketPath?: string;
  /** Deterministic local fixture only: replaces the isolated process launcher. */
  launch?: { binary: string; args: string[] };
}) {
  const path = options.socketPath ?? '/run/rat-things/browser.sock';
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const launch = options.launch ?? { binary: options.codexBinary, args: hostedCodexArguments(['sandbox', '--permission-profile', 'rat_managed', '--', process.execPath, '--input-type=module', '-e', source], options.network, false, options.directory) };
  const child = spawn(launch.binary, launch.args, { cwd: options.directory, ...options.identity, shell: false,
    env: { PATH: options.environment.PATH, HOME: options.environment.HOME, CODEX_HOME: options.environment.CODEX_HOME,
      TMPDIR: options.directory, RAT_BROWSER_ROLE: 'controller', RAT_BROWSER_NETWORK: JSON.stringify(options.network),
      ...(options.launch && options.environment.RAT_BROWSER_BINARY ? { RAT_BROWSER_BINARY: options.environment.RAT_BROWSER_BINARY } : {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map<string, { resolve(frame: BrowserFrame): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let closed = false; let partial = '';
  const fail = (reason = 'Shared browser worker stopped.') => { closed = true; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); } pending.clear(); };
  child.once('error', error => fail(`Shared browser worker could not start: ${error.message}`));
  child.once('exit', (code, signal) => fail(`Shared browser worker stopped (${code ?? signal}).`));
  child.stdin.on('error', () => fail('Shared browser worker input closed.')); child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    partial += chunk.toString();
    if (partial.length > 4 * 1024 * 1024) { fail(); child.kill(); return; }
    let index: number;
    while ((index = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, index); partial = partial.slice(index + 1);
      try {
        const result = JSON.parse(line); const request = pending.get(result.id); if (!request) continue;
        pending.delete(result.id); clearTimeout(request.timer);
        if (typeof result.error === 'string') request.reject(new SharedBrowserActionError(result.error));
        else { try { request.resolve(browserFrame(result.frame)); } catch (error) { request.reject(error as Error); } }
      } catch { fail(); child.kill(); }
    }
  });
  const executeWithDeadline = async (command: BrowserCommand, timeoutMs: number): Promise<BrowserFrame> => {
    const parsed = browserCommand(command);
    if (closed || pending.size >= 64) throw new SharedBrowserActionError('Shared browser is unavailable or busy.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new SharedBrowserActionError('Browser response timed out. Refresh before retrying.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, command: parsed }) + '\n', error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
    });
  };
  const execute = (command: BrowserCommand) => executeWithDeadline(command, 25_000);
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.setEncoding('utf8');
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (sockets.size > 64) { socket.destroy(); return; }
    let body = ''; socket.setTimeout(30000, () => socket.destroy());
    socket.on('data', chunk => { body += chunk.toString(); if (body.length > 32000) socket.destroy(); });
    socket.on('end', () => { void (async () => {
      try { socket.end(JSON.stringify({ frame: await execute(browserCommand(JSON.parse(body))) })); }
      catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Browser request failed.' })); }
    })(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    // Set the mode while still owning the inode. Local workers have CHOWN but
    // deliberately lack FOWNER, so chmod after handing ownership away fails.
    await chmod(path, 0o600); await chown(path, options.identity.uid, options.identity.gid);
  } catch (error) { child.kill(); server.close(); throw error; }
  let closing: Promise<void> | undefined;
  const owner = { execute, close: () => closing ??= (async () => {
    fail(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  })() };
  // Detect packaging or sandbox failures before starting paid agent inference.
  try { await executeWithDeadline({ command_id: 'worker_startup', operation: { action: 'snapshot' } }, 100_000); }
  catch (error) { await owner.close(); throw error; }
  return owner;
}
