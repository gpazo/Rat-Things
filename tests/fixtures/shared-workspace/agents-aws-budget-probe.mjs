import { registerHooks } from 'node:module';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const scratch=resolve(process.env.RT_PROBE_DIR); process.chdir(scratch); await mkdir('profile',{recursive:true});
process.env.AGENTS_AWS_LIVE='true'; process.env.AWS_E2E='true'; process.env.AWS_E2E_REAL_CODEX='true'; process.env.AWS_E2E_SHARED_SESSIONS='true';
process.env.AWS_E2E_CODEX_MODEL_ID='openai.gpt-5.6-luna'; process.env.AGENTS_AWS_MAX_MINUTES='5'; process.env.RAT_THINGS_LOCAL_DIR=resolve('profile');
process.env.SHARED_AGENTS_API_BASE_URL='https://fake.lambda-web.us-west-2.on.aws/v1'; process.env.RAT_THINGS_API_URL='https://operator.invalid';
process.env.AWS_REGION='us-west-2'; process.env.TEAM_OIDC_FIXTURE_JSON='{}';
const nativeFetch=globalThis.fetch.bind(globalThis); const invites=new Map(); const forwarded=[]; let currentActivity;
const json=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const mkActivity=(count)=>({session:{agent:{id:'agent_mock'}},turns:Array.from({length:count},(_,i)=>({id:`turn_${i}`,status:'completed',usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:0}}})),items:[{id:'assistant_1',type:'message',role:'assistant'}],inputs:[]});
currentActivity=mkActivity(1);
const mocks={
 '@playwright/test': `export const chromium={launch:async()=>({newPage:async()=>({goto:async()=>{},locator:()=>({fill:async()=>{},click:async()=>{}}),waitForURL:async()=>{}}),close:async()=>{}})};`,
 '../../../src/agents-client.js': `export const createAgentsClient=()=>({withOptions(){return this},async post(path){if(path==='/rat/spaces')return{id:'space_mock'};throw Error('unexpected operator '+path)}});`,
 '../../../src/client-connections.js': `const all=[]; export class TeamConnectionStore{constructor(path){this.path=path;this.rows=[];all.push(this)}async save(endpoint,provider,login){this.rows.push({id:'connection_mock',endpoint,provider,login})}async list(){return this.rows}async remove(id){this.rows=this.rows.filter(x=>x.id!==id)}}`,
 '../../../src/client-oidc.js': `export async function discoverTeamLogin(){return{login_providers:[{profile:'cognito_access',id:'provider_mock'}]}} export async function beginBrowserLogin(){return{url:'http://login.invalid',result:Promise.resolve({identity:{subject:'sub-claude'}}),close(){}}}`,
 '../../../src/console-team.js': `export class ConsoleTeams{async route(method,path){if(method==='POST'&&path==='/join')return{status:'choose_provider'};if(method==='POST'&&path==='/login')return{status:'waiting',id:'login_mock',url:'http://login.invalid'};if(method==='GET'&&path==='/login/login_mock'){globalThis.probeJoined=true;return{status:'complete',joined:{space:{id:'space_mock'},role:'collaborator'}}}throw Error('unexpected ConsoleTeams route '+method+' '+path)}close(){}}`,
 '../../../src/local-server.js': `import{createServer}from'node:http'; export async function startLocalServer(){const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://127.0.0.1').pathname;if(path==='/workspace/subscription'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({signed_in:true}));return}if(req.method==='POST'&&path==='/agents/sessions'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'session_mock'}));return}if(path==='/agents/sessions/session_mock/turns'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'local_turn',status:'completed'}]}));return}if(new URL(req.url,'http://127.0.0.1').pathname.startsWith('/workspace/shares/') && path!=='/workspace/shares'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'complete',error:null,destination_session_id:'session_mock'}));return}if(path==='/workspace/shares'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}if(path==='/agents/sessions/session_mock/events'){res.writeHead(409);res.end();return}res.writeHead(404);res.end()});server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return{baseURL:'http://127.0.0.1:'+server.address().port,token:'local_mock',close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))}}}`,
 '../../aws/team-identities.js': `export async function createTeamIdentities(){const make=name=>({username:name,loginPassword:'unused',issuer:'issuer_mock',subject:'sub-'+name,async accessTokenForRequest(){return'token-'+name}});return{users:[make('claude'),make('codex')],async close(){}}}`,
};
registerHooks({resolve(specifier,context,nextResolve){if(mocks[specifier])return{url:`data:text/javascript,${encodeURIComponent(mocks[specifier])}`,shortCircuit:true};return nextResolve(specifier,context)}});
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input)); if(url.hostname==='127.0.0.1')return nativeFetch(input,init); if(url.hostname!=='fake.lambda-web.us-west-2.on.aws')throw Error('unexpected fetch '+url);
 const path=url.pathname,method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):{};
 if(path.endsWith('/execution-roles/portable')&&method==='PUT')return json(200,{});
 if(path==='/v1/rat/spaces/space_mock/invites'&&method==='POST'){if(init.headers?.authorization==='Bearer token-codex')return json(403,{error:{code:'forbidden'}});const x={id:'invite_'+invites.size,token:'secret_'+invites.size,role:body.role,expires_at:9999999999};invites.set(x.id,x);return json(201,x)}
 if(path==='/v1/rat/spaces/space_mock/invites'&&method==='GET'){if(globalThis.probeJoined)invites.clear();return json(200,{data:[...invites.values()].map(({token,...x})=>x)})}
 if(/^\/v1\/rat\/spaces\/space_mock\/invites\/[^/]+$/.test(path)&&method==='DELETE'){invites.delete(path.split('/').at(-1));return new Response(null,{status:204})}
 if(path==='/v1/rat/spaces/space_mock/bindings')return json(403,{error:{code:'forbidden'}});
 if(path==='/v1/rat/spaces'&&method==='GET')return json(200,{data:[{id:'space_mock',role:'collaborator'}]});
 if(path==='/v1/rat/sessions/session_mock/activity'){if(init.headers?.authorization==='Bearer token-codex'&&!globalThis.probeJoined)return json(403,{error:{code:'forbidden'}});return json(200,currentActivity)}
 if(path==='/v1/rat/invites/redeem')return json(404,{error:{code:'not_found'}});
 if(path==='/v1/agents/sessions/session_mock/fork'&&method==='POST'){forwarded.push(method+' '+path);return json(201,{id:'fork_session_mock',object:'agent.session'})}
 if(path==='/v1/rat/sessions/session_mock/messages/'&&method==='POST'){forwarded.push(method+' '+path);return new Response(null,{status:204})}
 if(path==='/v1/rat/sessions/session_mock/%6dessages'&&method==='POST'){forwarded.push(method+' '+path);return new Response(null,{status:204})}
 if(path==='/v1/rat/sessions/session_mock/workspace/feedback'&&method==='POST'){forwarded.push(method+' '+path);return new Response(null,{status:204})}
 if(path==='/v1/agents/sessions/session_mock/events'&&method==='POST')return json(204,{});
 if(method==='DELETE'&&(path==='/v1/agents/sessions/session_mock'||path==='/v1/agents/agent_mock'))return json(200,{deleted:true});
 throw Error('unexpected fake AWS API request '+method+' '+path);
};
await import('../../../testing/shared-workspace/agents-aws/controller.ts');
const dirs=await readdir('profile'); const work=dirs.find(x=>x.startsWith('aws-live-')); if(!work)throw Error('AWS controller did not create its work directory.');
const details=JSON.parse(await readFile(join('profile',work,'relay','agents-live.json'),'utf8'));
const importedTurnCount=1;
const hostedTurnLimit=4;
currentActivity=mkActivity(importedTurnCount+hostedTurnLimit);
const headers={authorization:`Bearer ${details.participants.claude.token}`,'content-type':'application/json'};
const capped=await nativeFetch(details.url+'/api/v1/rat/sessions/session_mock/messages',{method:'POST',headers,body:JSON.stringify({text:'cap probe'})});
const bypass=await nativeFetch(details.url+'/api/v1/rat/sessions/session_mock/messages/',{method:'POST',headers,body:JSON.stringify({text:'trailing slash bypass probe'})});
const encoded=await nativeFetch(details.url+'/api/v1/rat/sessions/session_mock/%6dessages',{method:'POST',headers,body:JSON.stringify({text:'encoded path probe'})});
const feedback=await nativeFetch(details.url+'/api/v1/rat/sessions/session_mock/workspace/feedback',{method:'POST',headers,body:JSON.stringify({text:'feedback probe'})});
const fork=await nativeFetch(details.url+'/api/v1/agents/sessions/session_mock/fork',{method:'POST',headers,body:JSON.stringify({input:'alternate inference route'})});
const read=await nativeFetch(details.url+'/api/v1/rat/sessions/session_mock/activity',{headers});
console.log(`GUARD_RESULT=${JSON.stringify({bare_status:capped.status,trailing_slash_status:bypass.status,encoded_status:encoded.status,feedback_status:feedback.status,fork_status:fork.status,read_status:read.status,upstream_forwarded:forwarded})}`);
process.stdin.emit('end');
