import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sanitizeProbeOutput } from './codex-startup-probe-output.js';

export type CodexStartupPurpose = 'setup' | 'session';
const script = '/opt/agent-runtime/native-startup-probe.py';

export function observeCodexInitialization(options: {
  child: ChildProcess; purpose: CodexStartupPurpose; ordinal: number;
  spawnedAt: number; firstOutputAt: () => number | undefined; pending: () => boolean;
}): () => void {
  if (process.platform !== 'linux' || !existsSync(script)) return () => {};
  const startedAt = performance.now();
  let cancelled = false;
  let finishProbe: (() => void) | undefined;
  const timer = setTimeout(() => {
    const { child } = options;
    if (!options.pending() || child.exitCode !== null || child.signalCode !== null || !Number.isSafeInteger(child.pid) || child.pid! <= 0) return;
    const helper = spawn('/usr/bin/python3', ['-I', '-S', script, String(child.pid)], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
    });
    let settled = false;
    let bytes = 0;
    let output: Buffer[] = [];
    const finish = (status?: 'timeout' | 'output_limit' | 'failed' | 'complete') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
      if (status && !cancelled && options.pending()) {
        const observation = status === 'complete' ? sanitizeProbeOutput(Buffer.concat(output)) : null;
        const firstOutputAt = options.firstOutputAt();
        const elapsed = (time: number) => Math.min(3_600_000, Math.max(0, Math.round(time)));
        console.error(JSON.stringify({ message: 'Native harness startup sample', purpose: options.purpose, ordinal: options.ordinal,
          sinceSpawnMs: elapsed(performance.now() - options.spawnedAt), sinceRequestMs: elapsed(performance.now() - startedAt),
          requestAfterSpawnMs: elapsed(startedAt - options.spawnedAt),
          firstOutputAfterSpawnMs: firstOutputAt === undefined ? null : elapsed(firstOutputAt - options.spawnedAt),
          status: status === 'complete' ? observation ? 'sampled' : 'invalid_output' : status, observation,
        }));
      }
      output = [];
      helper.stdout.destroy();
    };
    const deadline = setTimeout(() => finish('timeout'), 1000);
    finishProbe = () => finish();
    helper.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 8192) { finish('output_limit'); return; }
      output.push(chunk);
    });
    helper.once('error', () => finish('failed'));
    helper.stdout.once('error', () => finish('failed'));
    helper.once('close', (code, signal) => finish(code === 0 && signal === null ? 'complete' : 'failed'));
  }, 25_000);
  timer.unref();
  return () => { cancelled = true; clearTimeout(timer); finishProbe?.(); };
}
