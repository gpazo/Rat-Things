import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createLocalRuntime } from './app/local-runtime.js';
import { installedNativeOptions, installedRuntime, installedServiceIdentity } from './app/local-installed.js';
import type { LocalRuntime } from './core/local-runtime-ports.js';
import type { ModelAccountStatus } from './core/harness-ports.js';
import type { LocalRuntimeStatus } from './domain/local-runtime.js';
import type { NativeRuntimeChangeView } from './domain/local-native-change.js';
import { connectLocalWorkspace, createLocalAgentsClient, localWorkspaceDirectory, readLocalConnection } from './local-workspace.js';
import type { TransferPlan } from './app/local-transfer.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function runWorkspaceCli(argv: string[], options: { runtime?: LocalRuntime } = {}): Promise<boolean> {
  if (argv[0] === 'transfer') {
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { 'api-url': { type: 'string' }, region: { type: 'string' }, model: { type: 'string' } } });
    const [operation, id] = positionals;
    if (!id || positionals.length !== 2 || !['plan', 'run', 'status'].includes(operation ?? '')) throw new Error('Use rat-things transfer plan SESSION --api-url URL --region REGION, or transfer run|status TRANSFER_ID');
    if (operation !== 'plan' && values.model !== undefined) throw new Error('Choose --model when creating a transfer plan; reviewed plans keep their destination model.');
    const client = createLocalAgentsClient(await readLocalConnection(undefined, installedServiceIdentity));
    let plan = operation === 'plan' ? await client.post<TransferPlan>('/workspace/transfers', { body: { session_id: id, endpoint: values['api-url'], region: values.region, ...(values.model !== undefined ? { model: values.model } : {}) } })
      : operation === 'run' ? await client.post<TransferPlan>(`/workspace/transfers/${id}`) : await client.get<TransferPlan>(`/workspace/transfers/${id}`);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (operation !== 'status') {
      while (['preparing', 'uploading', 'importing'].includes(plan.status)) {
        await delay(1000);
        plan = await client.get<TransferPlan>(`/workspace/transfers/${plan.id}`);
      }
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (plan.status === 'failed') throw new Error(plan.error ?? 'Transfer failed');
      if (plan.status === 'ready') process.stdout.write(`Review the destination and snapshot above. Copy with: rat-things transfer run ${plan.id}\n`);
    }
    return true;
  }
  if (argv[0] !== 'runtime' && argv[0] !== 'login') return false;
  const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true,
    options: { json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'no-browser': { type: 'boolean' } } });
  if (argv[0] === 'login') {
    if (positionals.length || values['dry-run']) throw new Error('Use rat-things login');
    await login({ json: values.json ?? false, browser: !values['no-browser'] });
    return true;
  }
  if (values['no-browser']) throw new Error('--no-browser is only available for login.');
  const operation = positionals[0] ?? 'doctor';
  if (positionals.length > 1 || !['doctor', 'status', 'setup', 'rollback'].includes(operation)) throw new Error('Use rat-things runtime doctor|status|setup|rollback [--dry-run] [--json]');
  if (installedRuntime) {
    if (options.runtime) throw new Error('Installed runtime commands use the local workspace service.');
    await withWorkspace(async (client, signal) => {
      if (['doctor', 'status'].includes(operation) || values['dry-run']) {
        showRuntime(await client.get<LocalRuntimeStatus>('/workspace/runtime', { signal }), values.json ?? false);
        return;
      }
      let change = await client.post<NativeRuntimeChangeView>(`/workspace/runtime/${operation}`, { body: { id: randomUUID() }, signal });
      let last = '';
      while (true) {
        const state = JSON.stringify(change);
        if (state !== last) {
          process.stdout.write(values.json ? `${state}\n` : `${'phase' in change ? change.phase : change.status}\n`);
          last = state;
        }
        if (!['queued', 'working'].includes(change.status)) break;
        await delay(500, undefined, { signal });
        change = await client.get<NativeRuntimeChangeView>(`/workspace/runtime/changes/${change.id}`, { signal });
      }
      if (change.status === 'failed') throw new Error('Runtime change failed. Check runtime status before retrying.');
      if (!values.json) process.stdout.write(change.status === 'awaiting_restart'
        ? 'Restart Rat Things to use the selected runtime.\n' : 'Local runtime is ready. Sign in with rat-things login.\n');
    });
    return true;
  }
  if (operation === 'rollback') throw new Error('Runtime rollback is available in the installed Rat Things app.');
  const runtime = options.runtime ?? createLocalRuntime(localWorkspaceDirectory());
  try {
    if (['doctor', 'status'].includes(operation) || values['dry-run']) {
      showRuntime(await runtime.status(), values.json ?? false);
      return true;
    }
    await runtime.setup();
    process.stdout.write('Local Linux runtime is ready. Sign in with rat-things login, then open rat-things console.\n');
    return true;
  } finally { if (!options.runtime) await runtime.close(); }
}

function showRuntime(status: LocalRuntimeStatus, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else for (const check of status.checks) process.stdout.write(`${check.ready ? 'Ready' : 'Needs setup'}: ${check.message}${!check.ready && check.action ? ` ${check.action}` : ''}\n`);
}

async function withWorkspace(work: (client: ReturnType<typeof createLocalAgentsClient>, signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Local command cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let workspace;
  try {
    workspace = await connectLocalWorkspace({ requiredService: installedServiceIdentity, start: async () => {
      const { startLocalServer } = await import('./local-server.js');
      return startLocalServer(await installedNativeOptions());
    } });
    controller.signal.throwIfAborted();
    await work(createLocalAgentsClient(workspace.connection), controller.signal);
  } finally {
    try { await workspace?.close(); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
}

async function login(options: { readonly json: boolean; readonly browser: boolean }): Promise<void> {
  await withWorkspace(async (client, signal) => {
    const startupDeadline = Date.now() + 180_000;
    while (installedRuntime) {
      const runtime = await client.get<LocalRuntimeStatus>('/workspace/runtime', { signal });
      if (!runtime.installation || runtime.ready) break;
      if (runtime.installation.state !== 'checking' || Date.now() >= startupDeadline) throw new Error('Set up the local runtime with rat-things runtime setup, then sign in.');
      await delay(500, undefined, { signal });
    }
    let account = await client.get<ModelAccountStatus>('/workspace/subscription', { signal });
    if (!account.signed_in) {
      const { id, url } = await client.post<{ id: string; url: string }>('/workspace/subscription/login', { body: { id: randomUUID() }, signal });
      try {
        process.stdout.write(options.json ? `${JSON.stringify({ url })}\n` : `Sign in to ChatGPT at ${url}\n`);
        if (options.browser && process.platform === 'darwin') await promisify(execFile)('/usr/bin/open', [url], { timeout: 5000 }).catch(() => {});
        const deadline = Date.now() + 10 * 60_000;
        while (!account.signed_in) {
          if (Date.now() >= deadline) throw new Error('Sign-in expired. Run rat-things login to try again.');
          await delay(1000, undefined, { signal });
          account = await client.get<ModelAccountStatus>('/workspace/subscription', { signal });
        }
      } finally {
        await client.delete(`/workspace/subscription/login/${id}`, { signal: AbortSignal.timeout(10_000) });
      }
    }
    process.stdout.write(options.json ? `${JSON.stringify(account)}\n` : 'ChatGPT subscription is connected to this local workspace.\n');
  });
}
