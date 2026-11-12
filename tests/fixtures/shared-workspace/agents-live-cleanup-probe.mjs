import { registerHooks } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const scratch = resolve(process.env.RT_PROBE_DIR);
process.chdir(scratch);
await mkdir('profile', { recursive: true });
process.env.RAT_AGENTS_LIVE = 'true';
process.env.RAT_THINGS_LOCAL_DIR = resolve('profile');
process.env.RAT_AGENTS_LIVE_MODEL = 'gpt-5.6-luna';
process.env.RAT_AGENTS_LIVE_MAX_TURNS = process.env.RT_MAX_TURNS ?? '2';

const mocks = {
  '../../../src/app/local-composition.js': `export const LOCAL_OWNER='owner_mock'; export function createLocalServices(){ return { subscription:{status:async()=>({signed_in:true})}, models:async()=>({data:[{id:'gpt-5.6-luna'}]}), sessions:{ create:async()=>({id:'session_mock'}), dispatch:async()=>{}, browserFrame:async()=>({epoch:1,revision:1}), browserAction:async()=>({epoch:1,revision:2}), turns:async()=>({data:Array.from({length:Number(process.env.RT_MAX_TURNS??2)},(_,i)=>({id:'turn_'+i,status:'completed',usage:{input_tokens:7,output_tokens:1}}))}), activity:async()=>({session:{id:'session_mock'},turns:[],items:[],inputs:[]}), collaboration:{typing:async()=>{}}, message:async()=>{globalThis.probeInferenceCalls++}, events:async()=>{globalThis.probeInferenceCalls++}, workspaceFeedback:async()=>{globalThis.probeInferenceCalls++}, fork:async()=>{globalThis.probeInferenceCalls++;return{id:'fork_session_mock',object:'agent.session'}} }, close:async()=>{ if(process.env.RT_CLOSE_FAIL==='true') throw new Error('mock services shutdown failed'); } }; }`,
  '../../../src/domain/local-runtime.js': `export function localWorkerNames(){return {volume:'rat-things-live-mock'};}`,
  '../../../src/domain/shared-browser.js': `export const sharedBrowserTool={type:'function',name:'shared_browser'};`,
  '../../../src/lambdas/activity-stream.js': `export function activityStream(){return new Response(null,{status:200});}`,
  'node:child_process': `export function execFile(command,args,options,callback){ if(typeof options==='function'){callback=options;options={}} const timeout=options?.timeout; globalThis.probeDockerCalls.push({command,args,timeout}); console.log('MOCK_DOCKER_CALL='+JSON.stringify({command,args,timeout})); const failed=args.includes(process.env.RT_DOCKER_FAIL_VOLUME); if(failed) console.error('MOCK_DOCKER_ERROR: volume removal failed'); const filter=args.find(value=>value.startsWith('name=')); const volume=filter?.slice(5); callback(failed?new Error('mock Docker volume removal failure'):null,{stdout:volume===process.env.RT_DOCKER_FAIL_VOLUME?volume:'',stderr:''}); }`,
};
globalThis.probeDockerCalls = [];
globalThis.probeInferenceCalls = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

await import('../../../testing/shared-workspace/agents-live/server.ts');
const connection = JSON.parse(await readFile(join('profile', 'agents-live.json'), 'utf8'));
if (process.env.RT_PROBE_MODE === 'routes') {
  const headers = { authorization: `Bearer ${connection.participants.claude.token}`, 'content-type': 'application/json' };
  const request = (path, body = {}) => fetch(`${connection.url}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const trailing = await request('/v1/rat/sessions/session_mock/messages/', { text: 'trailing slash' });
  const encoded = await request('/v1/rat/sessions/session_mock/%6dessages', { text: 'encoded segment' });
  const feedback = await request('/v1/rat/sessions/session_mock/workspace/feedback', { text: 'feedback' });
  const fork = await request('/v1/agents/sessions/session_mock/fork', { input: 'alternate inference route' });
  const read = await fetch(`${connection.url}/api/v1/rat/sessions/session_mock/activity`, { headers: { authorization: headers.authorization } });
  const typing = await request('/v1/rat/sessions/session_mock/typing', { client_id: 'probe', sequence: 1, typing: true });
  const browser = await request('/v1/rat/sessions/session_mock/workspace/browser', { epoch: 1, revision: 1, operation: { action: 'reload' } });
  console.log(`GUARD_RESULT=${JSON.stringify({ trailing_slash_status: trailing.status, encoded_status: encoded.status, feedback_status: feedback.status, fork_status: fork.status, read_status: read.status, typing_status: typing.status, browser_status: browser.status, inference_calls: globalThis.probeInferenceCalls })}`);
}
process.stdin.emit('end');
