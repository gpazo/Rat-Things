import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { executionCommandDependencies } from '../adapters/execution-command-transport.js';
import { createAwsClients, S3ArtifactStore } from '../adapters/aws-runtime.js';
import { workerOptionsFromEnv } from '../adapters/executors.js';
import { runHookPayload } from '../adapters/worker-launch.js';
import { sameExecution } from '../core/execution-command-planning.js';
import type { ExecutionReference, RunRequest } from '../domain/contracts.js';

const origin = 'http://127.0.0.1:8080';
const hook = '/aws/lambda-microvms/runtime/v1';

/** Root-only host loop. There is no listener, shell command, or AWS credential in the guest. */
async function supervise(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('EC2 supervisor requires root.');
  const configuration = JSON.parse(await readFile('/etc/rat-worker/environment.json', 'utf8')) as Record<string, string>;
  for (const [name, value] of Object.entries(configuration)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') throw new Error('Invalid worker configuration.');
    process.env[name] = value;
  }
  process.env.DEFAULT_EXECUTION_BACKEND = 'ec2';
  const metadataToken = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(5000),
  }).then(responseText);
  const metadata = (path: string) => fetch(`http://169.254.169.254/latest/meta-data/${path}`, {
    headers: { 'X-aws-ec2-metadata-token': metadataToken }, signal: AbortSignal.timeout(5000),
  }).then(responseText);
  const [id, runId, generation] = await Promise.all([metadata('instance-id'), metadata('tags/instance/RatRunId'), metadata('tags/instance/RatGeneration')]);
  if (!/^i-[a-f0-9]+$/.test(id) || !/^[A-Za-z0-9-]{1,128}$/.test(runId) || !/^[a-f0-9]{64}$/.test(generation)) throw new Error('Invalid worker identity.');
  const execution: ExecutionReference = { backend: 'ec2', id, generation };
  const target = { runId, execution };
  const { runs, commands } = executionCommandDependencies();
  let run = await runs.get(runId);
  const attachmentDeadline = Date.now() + 120_000;
  while (run?.status === 'dispatching' && (!run.execution || run.execution.id === 'pending') && Date.now() < attachmentDeadline) {
    await pause(250); run = await runs.get(runId);
  }
  if (!run?.agentsSession || run.status !== 'dispatching' || !run.execution || !sameExecution(target, { runId, execution: run.execution })) throw new Error('Worker execution authority is unavailable.');
  const artifacts = new S3ArtifactStore(createAwsClients(undefined, { operationTimeoutMs: 30_000 }).s3, run.input.bucket);
  const request = await artifacts.getJson<RunRequest>(run.input);
  const payload = runHookPayload(run, request, workerOptionsFromEnv());
  const server = spawn(process.execPath, ['/opt/agent-runtime/runtime-server.mjs'], { cwd: '/opt/agent-runtime', env: process.env, stdio: 'inherit' });
  let exited = false;
  const finished = new Promise<void>((resolve, reject) => {
    server.once('error', (error) => { exited = true; reject(error); });
    server.once('exit', () => { exited = true; resolve(); });
  });
  // Attach a handler immediately: startup failure must not become an unhandled rejection.
  void finished.catch(() => undefined);
  const stop = () => { server.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      if (exited) throw new Error('Lifecycle server exited before readiness.');
      try { await postHook('ready', {}); break; }
      catch (error) { if (Date.now() >= readyDeadline) throw error; await pause(250); }
    }
    await postHook('run', { microvmId: id, runHookPayload: payload });
    while (!exited) {
      const current = await runs.get(runId);
      if (!current?.execution || !sameExecution(target, { runId, execution: current.execution }) || !['dispatching', 'running'].includes(current.status)) break;
      await commands.drain(run.ownerId, target, async (command, deadline) => {
        const response = await fetch(`${origin}${command.path}`, {
          method: command.method,
          ...(command.body ? { body: JSON.stringify(command.body), headers: { 'content-type': 'application/json' } } : {}),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        return { status: response.status, body: await response.json() as unknown };
      });
      await pause(250);
    }
  } finally {
    stop();
    const forced = setTimeout(() => server.kill('SIGKILL'), 30_000);
    try { await finished; } finally { clearTimeout(forced); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Host request failed with HTTP ${response.status}.`);
  return response.text();
}
async function postHook(operation: string, body: unknown) {
  return fetch(`${origin}${hook}/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).then(responseText);
}

supervise().catch((error: unknown) => {
  console.error(JSON.stringify({ message: 'EC2 worker supervisor failed; terminating this execution.',
    error: error instanceof Error ? error.name : 'UnknownError',
    requestId: typeof error === 'object' && error !== null && '$metadata' in error
      ? (error.$metadata as { requestId?: string } | undefined)?.requestId : undefined,
  }));
  process.exitCode = 1;
});
