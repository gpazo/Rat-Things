import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { Turn } from '../../src/domain/agents-api.js';

it('keeps an environment command process alive across completed root Turns', async () => {
  const home = await mkdtemp('/tmp/rat-process-lifetime-');
  const startedPath = join(home, 'started.json');
  const signalPath = join(home, 'continue');
  const resultPath = join(home, 'continued.json');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const firstProgram = `const fs=require('node:fs'); const nonce=require('node:crypto').randomUUID();
    fs.writeFileSync(${JSON.stringify(startedPath)},JSON.stringify({nonce})); console.log('PROCESS_STARTED');
    const timer=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(signalPath)})) {
      fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({nonce})); console.log('PROCESS_CONTINUED');clearInterval(timer);clearTimeout(deadline);
    } },50); const deadline=setTimeout(()=>process.exit(2),20000);`;
  const secondProgram = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(signalPath)},'continue');
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(resultPath)})) {
      console.log(fs.readFileSync(${JSON.stringify(resultPath)},'utf8')); clearInterval(timer);clearTimeout(deadline);
    }},50);const deadline=setTimeout(()=>process.exit(2),5000);`;
  let calls = 0;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString())); calls++;
    const item = calls === 1 || calls === 3
      ? { type: 'function_call', name: 'exec_command', id: `command_${calls}`, call_id: `command_${calls}`,
        arguments: JSON.stringify({ cmd: `${quote(process.execPath)} -e ${quote(calls === 1 ? firstProgram : secondProgram)}`, yield_time_ms: 1000, max_output_tokens: 1000 }) }
      : { type: 'message', id: `done_${calls}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Command accepted.' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id: `response_${calls}` } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response_${calls}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, home, 20000, {}), {
    sessionId: 'sess_process', turnId: 'turn_one', input: [], agent: sessionAgent({ model: 'gpt-5.4' }, 'agent_process', 1),
    environment: { id: 'env_process', type: 'openai_hosted', files: [], skills: [], plugins: [], capability_directories: [], packages: { npm: [], python: [], system: [] }, network: { access: 'enabled', allowed_domains: [] } },
  });
  const runtime = new SessionRuntime({ sessionId: 'sess_process', agentId: 'agent_process', request: {
    ...planned, binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    workspace: home, executionWorkspace: home, environments: [{ environmentId: 'local', cwd: home }],
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, timeoutMs: 20000, persistent: true,
    prompt: '', sandbox: 'read-only', model: 'gpt-5.4', modelProvider: 'fixture', networkAccess: true,
    sessionConfig: { ...planned.sessionConfig, 'model_providers.fixture': { name: 'local fixture',
      base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
  } });
  const turn = (id: string): Turn => ({ id, object: 'agent.session.turn', session_id: 'sess_process', agent_id: 'agent_process', subagent_id: null,
    status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null });
  const complete = async (id: string) => {
    await runtime.start(turn(id), [{ role: 'user', content: [{ type: 'input_text', text: id }] }]);
    for (let count = 0; count < 1000; count++) {
      if (runtime.snapshot().turns.find(value => value.turn.id === id)?.turn.status === 'completed') return;
      await delay(10);
    }
    throw new Error(JSON.stringify({ state: runtime.snapshot(), requests }));
  };
  try {
    await runtime.initialize(); await complete('turn_one');
    const started = JSON.parse(await readFile(startedPath, 'utf8'));
    await delay(1000); await complete('turn_two');
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(started);
    expect(calls).toBe(4);
    expect(JSON.stringify(requests[1])).toContain('PROCESS_STARTED');
    expect(JSON.stringify(requests[3])).toContain(started.nonce);
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
