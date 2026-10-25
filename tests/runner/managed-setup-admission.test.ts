import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareHostedEnvironment } from '../../src/runner/hosted-environment.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

it('refuses an unenforced executor before materializing input, running setup, or publishing readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-setup-admission-'));
  const workspace = join(root, 'workspace'), stateDirectory = join(root, 'state');
  await mkdir(workspace);
  const binary = join(root, 'unsandboxed-executor.mjs');
  const invocations = join(root, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  appendFileSync(${JSON.stringify(invocations)},JSON.stringify(request.method)+'\\n');
  const reply=result=>process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
  if(request.method==='initialize')return reply({userAgent:'unconfined-test-executor'});
  if(request.method==='command/exec')return execFile(request.params.command[0],request.params.command.slice(1),{cwd:request.params.cwd},(error,stdout,stderr)=>reply({exitCode:error?.code??0,stdout,stderr}));
  throw new Error('Unexpected inference or native operation');
});
`, { mode: 0o700 });
  const configuration = { network: { access: 'disabled' as const },
    files: [{ type: 'inline' as const, path: '/workspace/input', data: Buffer.from('must not be materialized').toString('base64') }],
    setup_commands: [{ command: 'touch setup-ran', cwd: workspace }] };
  const environment = { ...publicTemplate(configuration, { id: 'environment', created_at: 1, updated_at: 1 }), type: 'openai_hosted' as const, files: [], skills: [] };
  const launch = { sessionId: 'session', turnId: 'turn', input: [], environment, hostedConfiguration: configuration, agent: sessionAgent({ model: 'fixture' }, 'agent', 1) };
  const plan = planCodexLaunch({ version: '1', prompt: '' }, workspace, 10000, { CODEX_BINARY: binary, PATH: process.env.PATH });
  try {
    await expect(prepareHostedEnvironment({ launch, workspace, plan, stateDirectory, artifacts: { getBytes: async () => { throw new Error('Unexpected artifact read'); } } }))
      .rejects.toThrow('Refusing to expose execution tools');
    expect((await readFile(invocations, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(['initialize', 'command/exec']);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(stateDirectory)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
