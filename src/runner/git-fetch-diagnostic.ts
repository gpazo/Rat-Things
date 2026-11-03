import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sanitizeGitFetchProbeOutput } from './git-fetch-probe-output.js';

const script = '/opt/agent-runtime/native-startup-probe.py';

export function observeGitFetch(pid: number): () => void {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !existsSync(script) || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return () => {};
  let cancelled = false;
  let finishProbe: (() => void) | undefined;
  const timer = setTimeout(() => {
    let helper;
    try {
      helper = spawn('/usr/bin/python3', ['-I', '-S', script, '--git-fetch', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
      });
    } catch { return; }
    let settled = false;
    let bytes = 0;
    let output: Buffer[] = [];
    const finish = (status?: 'timeout' | 'output_limit' | 'failed' | 'complete') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
      if (status && !cancelled) {
        const observation = status === 'complete' ? sanitizeGitFetchProbeOutput(Buffer.concat(output)) : null;
        console.error(JSON.stringify({ message: 'Git fetch wait sample',
          status: status === 'complete' ? observation ? 'sampled' : 'invalid_output' : status, observation }));
      }
      output = [];
      helper.stdout.destroy();
    };
    const deadline = setTimeout(() => finish('timeout'), 1000);
    deadline.unref();
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
  }, 20_000);
  timer.unref();
  return () => { cancelled = true; clearTimeout(timer); finishProbe?.(); };
}
