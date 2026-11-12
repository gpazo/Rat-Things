import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyDemoRoute } from '../../testing/shared-workspace/demo-policy.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const awsProbe = fileURLToPath(new URL('../fixtures/shared-workspace/agents-aws-budget-probe.mjs', import.meta.url));
const localProbe = fileURLToPath(new URL('../fixtures/shared-workspace/agents-live-cleanup-probe.mjs', import.meta.url));
const scratchPaths: string[] = [];

afterEach(async () => {
  await Promise.all(scratchPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('shared workspace demo guards', () => {
  it('matches router decoding while keeping unsafe and alternate inference paths closed', () => {
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/messages/', 'session_mock')).toEqual({ kind: 'inference' });
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/%6dessages', 'session_mock')).toEqual({ kind: 'inference' });
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/workspace/feedback', 'session_mock')).toEqual({ kind: 'inference' });
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/messages%2Fother', 'session_mock')).toEqual({ kind: 'deny' });
    expect(classifyDemoRoute('POST', '/v1/agents/sessions/session_mock/fork', 'session_mock')).toEqual({ kind: 'deny' });
    expect(classifyDemoRoute('POST', '/v1/agents/sessions', 'session_mock')).toEqual({ kind: 'deny' });
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/typing', 'session_mock')).toEqual({ kind: 'proxy' });
    expect(classifyDemoRoute('GET', '/v1/rat/sessions/session_mock/activity/events', 'session_mock')).toEqual({ kind: 'proxy' });
    expect(classifyDemoRoute('POST', '/v1/rat/sessions/session_mock/%E0%A4%A', 'session_mock')).toEqual({ kind: 'deny' });
  });

  it('applies the exhausted Turn limit to normalized local and AWS inference routes', async () => {
    const aws = await runProbe(awsProbe);
    const local = await runProbe(localProbe, { RT_PROBE_MODE: 'routes' });

    expect(aws.code).toBe(0);
    expect(readResult(aws.stdout)).toMatchObject({
      bare_status: 429,
      trailing_slash_status: 429,
      encoded_status: 429,
      feedback_status: 429,
      fork_status: 404,
      read_status: 200,
      upstream_forwarded: [],
    });
    expect(local.code).toBe(0);
    expect(readResult(local.stdout)).toMatchObject({
      trailing_slash_status: 429,
      encoded_status: 429,
      feedback_status: 429,
      fork_status: 404,
      read_status: 200,
      typing_status: 204,
      browser_status: 200,
      inference_calls: 0,
    });
  }, 60_000);

  it('records partial cleanup, tries independent resources, and exits nonzero on failures', async () => {
    const probe = await runProbe(localProbe, {
      RT_CLOSE_FAIL: 'true',
      RT_DOCKER_FAIL_VOLUME: 'rat-things-live-mock',
    });
    const evidence = await readCleanup(probe.directory);
    const dockerCalls = probe.stdout.split('\n')
      .filter(line => line.startsWith('MOCK_DOCKER_CALL='))
      .map(line => JSON.parse(line.slice('MOCK_DOCKER_CALL='.length)) as { args: string[]; timeout: number });

    expect(probe.code).toBe(1);
    expect(evidence.status).toBe('incomplete');
    expect(evidence.resources).toMatchObject({
      local_services: { status: 'failed' },
      connection_file: { status: 'removed' },
      worker_volume: { status: 'failed', retained: true },
      state_volume: { status: 'removed' },
    });
    expect(dockerCalls.map(call => call.args)).toEqual([
      ['volume', 'rm', 'rat-things-live-mock'],
      ['volume', 'rm', 'rat-things-live-mock-state'],
      ['volume', 'ls', '--filter', 'name=rat-things-live-mock', '--format', '{{.Name}}'],
    ]);
    expect(dockerCalls.map(call => call.timeout)).toEqual([30_000, 30_000, 30_000]);
  }, 30_000);

  it('records successful cleanup and exits zero when every cleanup action succeeds', async () => {
    const probe = await runProbe(localProbe);
    const evidence = await readCleanup(probe.directory);

    expect(probe.code).toBe(0);
    expect(evidence.status).toBe('removed');
    expect(evidence.resources).toMatchObject({
      local_services: { status: 'removed' },
      connection_file: { status: 'removed' },
      worker_volume: { status: 'removed' },
      state_volume: { status: 'removed' },
    });
  }, 30_000);
});

interface ProbeResult { code: number | null; stdout: string; stderr: string; directory: string }
interface CleanupEvidence {
  status: string;
  resources: Record<string, { status: string; retained?: boolean }>;
}

async function runProbe(script: string, overrides: Record<string, string> = {}): Promise<ProbeResult> {
  const directory = await mkdtemp(join(tmpdir(), 'rat-shared-demo-'));
  scratchPaths.push(directory);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: root,
      env: { ...process.env, RT_PROBE_DIR: directory, ...overrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === null && !stderr.includes('SIGKILL')) reject(new Error(`Probe ended without an exit code.\n${stderr}`));
      else resolvePromise({ code, stdout, stderr, directory });
    });
  });
}

function readResult(stdout: string): Record<string, unknown> {
  const line = stdout.split('\n').find(value => value.startsWith('GUARD_RESULT='));
  if (!line) throw new Error(`Probe did not emit its result.\n${stdout}`);
  return JSON.parse(line.slice('GUARD_RESULT='.length)) as Record<string, unknown>;
}

async function readCleanup(directory: string): Promise<CleanupEvidence> {
  return JSON.parse(await readFile(join(directory, 'artifacts/shared-workspace/agents-live/cleanup.json'), 'utf8')) as CleanupEvidence;
}
