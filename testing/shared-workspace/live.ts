import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { createAgentsClient } from '../../src/agents-client.js';
import { createTeamIdentities, type TeamIdentityFixture, type TestTeamIdentity } from '../aws/team-identities.js';
import { sharedBrowserTool, browserFrame, type BrowserFrame } from '../../src/domain/shared-browser.js';
import type { SessionService } from '../../src/core/session-service.js';
import { acknowledgedFeedback } from './assertions.js';
import type { SessionPlan } from '../../src/domain/session-plan.js';

type Activity = Awaited<ReturnType<SessionService['activity']>>;
const required = (key: string): string => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
const model = 'openai.gpt-5.6-luna';
assert.equal(process.env.AWS_E2E, 'true');
assert.equal(process.env.AWS_E2E_REAL_CODEX, 'true');
assert.equal(process.env.AWS_E2E_CODEX_MODEL_ID, model, 'This bounded proof only permits the selected inexpensive model.');
const baseURL = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
const region = required('AWS_REGION');
assert(new URL(baseURL).hostname.endsWith(`.lambda-web.${region}.on.aws`));
const directory = process.env.WORKSPACE_PROOF_OUTPUT ?? 'artifacts/shared-workspace/live-aws';
await mkdir(directory, { recursive: true });
const proof = `workspace-${randomUUID()}`;
const visualCode = `TEAM-${randomUUID().slice(0, 4).toUpperCase()}`;
const priorInferenceUsd = Number(process.env.WORKSPACE_PROOF_PRIOR_INFERENCE_USD ?? '0');
assert(Number.isFinite(priorInferenceUsd) && priorInferenceUsd >= 0 && priorInferenceUsd < 1);
let stopRequested = false;
process.once('SIGINT', () => { stopRequested = true; });
const started = Date.now();
const deadline = started + 20 * 60_000;
const evidence: Record<string, unknown> = { proof, model, prior_inference_usd: priorInferenceUsd, started_at: new Date(started).toISOString(), client_kind: 'Independent authenticated HTTP/SSE clients (not native UI windows)', checks: [], timings_ms: {}, limitations: ['Single scenario; not a load benchmark', 'Cost estimate excludes infrastructure billing'], pricing: { source: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html', input_per_million_usd: .22, output_per_million_usd: 1.32, cache_read_per_million_usd: .022 } };
const timings = evidence.timings_ms as Record<string, number>;
const check = (name: string) => { (evidence.checks as string[]).push(name); console.log(JSON.stringify({ check: name, elapsed_ms: Date.now() - started })); };
const identities = await createTeamIdentities(JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture, region, ['designer', 'engineer', 'qa', 'viewer', 'outsider']);
const [designer, engineer, qa, viewer, outsider] = identities.users as [TestTeamIdentity, TestTeamIdentity, TestTeamIdentity, TestTeamIdentity, TestTeamIdentity];
const operator = createAgentsClient({ baseURL: `${required('RAT_THINGS_API_URL').replace(/\/$/, '')}/v1`, region }).withOptions({ maxRetries: 0 });
let spaceId: string | undefined;
let agentId: string | undefined;
let sessionId: string | undefined;
const watches: ReturnType<typeof watchActivity>[] = [];
let last: Activity | undefined;
const client = () => new OpenAI({ baseURL, apiKey: designer.accessTokenForRequest, maxRetries: 0, timeout: 180_000, defaultHeaders: { 'X-Rat-Space': spaceId! } });
const request = async (person: TestTeamIdentity, path: string, method = 'GET', body?: unknown, key?: string) => fetch(`${baseURL}${path}`, {
  method, redirect: 'error', signal: AbortSignal.timeout(180_000),
  headers: { authorization: `Bearer ${await person.accessTokenForRequest()}`, 'X-Rat-Space': spaceId!, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async <T>(person: TestTeamIdentity, path: string, method = 'GET', body?: unknown, key?: string): Promise<T> => {
  const response = await request(person, path, method, body, key);
  if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; throw new Error(`${method} ${path}: ${response.status} ${error.error?.code ?? ''} ${error.error?.message ?? ''}`); }
  return (response.status === 204 ? undefined : await response.json()) as T;
};
const activity = async () => { last = await json<Activity>(designer, `/rat/sessions/${sessionId}/activity`); enforceBudget(last); return last; };
const feedback = async (person: TestTeamIdentity, body: unknown, key: string) => {
  const before = Date.now(); await json(person, `/rat/sessions/${sessionId}/workspace/feedback`, 'POST', body, key); timings[`accept_${key}`] = Date.now() - before;
};
try {
  spaceId = (await operator.post<{ id: string }>('/rat/spaces', { body: { name: proof, manager: { issuer: designer.issuer, subject: designer.subject, label: 'Designer' } } })).id;
  evidence.space_id = spaceId;
  for (const [person, role, label] of [[engineer, 'collaborator', 'Engineer'], [qa, 'collaborator', 'QA'], [viewer, 'viewer', 'Observer']] as const) await json(designer, `/rat/spaces/${spaceId}/bindings`, 'POST', { issuer: person.issuer, subject: person.subject, role, label });
  const page = `<!doctype html><html><head><title>Works on our machines</title></head><body style="font:24px sans-serif;padding:64px"><h1>Works on our machines</h1><p>${proof}</p><p>One shared direction. Design, engineering and QA contribute together.</p><button style="position:absolute;left:64px;top:400px;font:24px sans-serif;padding:20px" onclick="document.querySelector('#status').textContent='Reviewed together'">Review direction</button><p id="status">Ready for feedback</p><input aria-label="Visual code" style="position:absolute;left:64px;top:520px;width:600px;height:50px;font:32px sans-serif" placeholder="Visual code"></body></html>`;
  const environment = { type: 'openai_hosted' as const, network: { access: 'disabled' as const, allowed_domains: [] },
    files: [{ type: 'inline' as const, path: '/workspace/outputs/index.html', data: Buffer.from(page).toString('base64') }] };
  await json(designer, `/rat/spaces/${spaceId}/execution-roles/default`, 'PUT', { name: 'Shared browser proof', models: [model], tools: [sharedBrowserTool], environments: [environment], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [], max_subagents: 0 });
  agentId = (await client().beta.agents.create({ name: proof, model, tools: [sharedBrowserTool], multi_agent: { enabled: false }, reasoning: { effort: 'low' }, instructions: 'Collaborate with Designer, Engineer, and QA on one shared product direction. Keep replies under 120 words. Never delegate or use external network. Perform only requested steps, at most four tool calls per Turn. Maintain exactly three stable Plan items: direction, scope, access. Use rat_things_plan_update with the current host revision and actual accepted message IDs. Keep previous source references when updating. For each received annotation, acknowledge its contributor and exact feedback marker, update /workspace/outputs/direction.txt with the accumulated feedback including its exact markers and the visual code, then mark the relevant Plan item addressed with a reason and result link {kind:"output",path:"/workspace/outputs/direction.txt"}. Items whose feedback has not arrived stay next. Only the admitted Plan tool publishes Plan changes. Never claim the Plan was updated without a successful tool result.' })).id;
  await json(designer, `/rat/agents/${agentId}/workload`, 'PUT', { execution_role_id: 'default' });
  check('OIDC roles and fixed browser execution grant configured');
  const begin = Date.now();
  const initialPrompt = `The supplied /workspace/outputs/index.html is a fixed browser fixture; do not rewrite it. Use the rat_shared_browser browser tool: snapshot to obtain epoch/revision, then navigate to https://rat-artifacts.invalid/index.html using those values. Navigation may acknowledge before the page loads: call snapshot again to read the loaded page title and content. Finally call rat_things_plan_update with expected_revision 0 and exactly three next items: direction (clarify the product direction), scope (keep the release small), access (include everyone with access). Omit optional reason on next items. Cite this input's actual host message ID and link {kind:"output",path:"/workspace/outputs/index.html"}. Verify the actual browser page title and reply READY with the exact page title. Do not read unrelated files.`;
  const session = await client().beta.agents.sessions.create({ agent_id: agentId, environment });
  sessionId = session.id; evidence.session_id = sessionId; timings.session_submit = Date.now() - begin;
  check('Shared Session accepted');
  const initial = await activity();
  for (const person of [designer, engineer, qa]) {
    const watch = watchActivity(baseURL, spaceId, sessionId, await person.accessTokenForRequest(), initial.cursor);
    watches.push(watch); await watch.ready;
  }
  const preflightErrors = new Set<number>();
  const readyFrame = await until(async () => {
    const response = await request(designer, `/rat/sessions/${sessionId}/workspace/browser`);
    if (response.ok) return browserFrame(await response.json());
    preflightErrors.add(response.status); await response.body?.cancel();
    assert([409, 502, 503].includes(response.status), `Browser preflight returned ${response.status}`);
    await activity(); return undefined;
  }, value => value !== undefined, 180_000);
  assert(readyFrame); assert.equal((await activity()).turns.length, 0);
  timings.browser_ready_without_inference = Date.now() - begin;
  evidence.preflight_http_statuses = [...preflightErrors];
  check('Browser initialized in an idle Session with zero model Turns');
  const promptStarted = Date.now();
  await client().beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: initialPrompt }] }] }] }, { headers: { 'Idempotency-Key': `${proof}-initial` } });
  timings.initial_prompt_submit = Date.now() - promptStarted;
  const completed = await until(activity, current => {
    if (!timings.first_assistant && assistantText(current)) { timings.first_assistant = Date.now() - begin; timings.first_assistant_after_prompt = Date.now() - promptStarted; }
    return settled(current);
  }, 8 * 60_000);
  timings.first_turn_complete = Date.now() - begin;
  assert(completed.items.some(item => item.type === 'mcp_call' && item.server_label === 'rat_shared_browser' && item.name === 'browser' && item.status === 'completed' && browserOutputText(item.output).includes('Works on our machines')), 'The agent must observe the loaded page through an actual browser tool result');
  assert(completed.items.some(item => item.type === 'mcp_call' && item.server_label === 'rat_shared_browser' && item.name === 'browser' && item.status === 'completed' && item.error === null && JSON.stringify(item.output).includes('https://rat-artifacts.invalid/index.html')), 'Must observe successful real browser navigation output');
  check('Real agent opened the supplied page through the browser');
  assert(completed.plan && completed.plan.revision >= 1, 'The real agent must create the Session Plan through its admitted tool');
  const originalPlan = structuredClone(completed.plan);
  assert.deepEqual(new Set(originalPlan.items.map(item => item.id)), new Set(['direction', 'scope', 'access']));
  check('Real root agent published the initial Plan');
  const getFrame = async (person: TestTeamIdentity) => browserFrame(await json(person, `/rat/sessions/${sessionId}/workspace/browser`));
  await until(() => getFrame(designer), frame => frame.title === 'Works on our machines' && frame.text.includes(proof), 15_000);
  const frames = await Promise.all([designer, engineer, qa].map(getFrame));
  assert.equal(new Set(frames.map(frame => `${frame.epoch}:${frame.revision}:${frame.frame_id}`)).size, 1);
  assert(frames[0]!.text.includes(proof));
  assert.equal(frames[0]!.title, 'Works on our machines');
  await writeFile(`${directory}/initial-browser.jpg`, Buffer.from(frames[0]!.image, 'base64'));
  check('All three identities see the same live page after the Turn ends');
  const beforeAction = frames[0]!;
  // Clicking through the authenticated API changes the one browser all participants observe.
  let moved = browserFrame(await json(engineer, `/rat/sessions/${sessionId}/workspace/browser`, 'POST', { epoch: beforeAction.epoch, revision: beforeAction.revision, operation: { action: 'click', x: .15, y: .54 } }, 'shared-click'));
  assert.equal(moved.epoch, beforeAction.epoch); assert(moved.revision > beforeAction.revision);
  moved = await until(() => getFrame(designer), frame => frame.text.includes('Reviewed together'), 10_000);
  assert(moved.text.includes('Reviewed together'), 'Shared browser click must change the page');
  const observed = await Promise.all([designer, qa].map(getFrame));
  assert(observed.every(frame => frame.text.includes('Reviewed together')));
  check('Engineer navigation is visible to Designer and QA');
  moved = browserFrame(await json(qa, `/rat/sessions/${sessionId}/workspace/browser`, 'POST', { epoch: moved.epoch, revision: moved.revision, operation: { action: 'click', x: .2, y: .68 } }, 'focus-code'));
  moved = browserFrame(await json(qa, `/rat/sessions/${sessionId}/workspace/browser`, 'POST', { epoch: moved.epoch, revision: moved.revision, operation: { action: 'type', text: visualCode } }, 'type-code'));
  assert(!moved.text.includes(visualCode), 'Visual-only challenge must not appear in browser text');
  evidence.visual_code = visualCode;
  const capture = await json<{ id: string; frame: BrowserFrame }>(designer, `/rat/sessions/${sessionId}/workspace/browser/capture`, 'POST', { frame_id: moved.frame_id });
  assert.equal(capture.frame.frame_id, moved.frame_id);
  await writeFile(`${directory}/annotated-browser.jpg`, Buffer.from(capture.frame.image, 'base64'));
  const captureHash = createHash('sha256').update(capture.frame.image).digest('hex');
  evidence.capture = { id: capture.id, epoch: capture.frame.epoch, revision: capture.frame.revision, frame_id: capture.frame.frame_id, image_sha256: captureHash };
  const element = capture.frame.elements?.find(item => item.text.includes('Works on our machines'));
  assert(element, 'The real Chromium capture must contain selectable headline metadata');
  moved = browserFrame(await json(engineer, `/rat/sessions/${sessionId}/workspace/browser`, 'POST', { epoch: moved.epoch, revision: moved.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html?after-capture' } }, 'move-after-capture'));
  assert.equal(moved.url, 'https://rat-artifacts.invalid/index.html?after-capture');
  const designText = `DESIGN-${proof}: Make the shared direction clear. Read and repeat the visual code shown inside the input field in the attached capture. Record my feedback and that code in direction.txt, then update the direction Plan item with my source message and the saved output.`;
  const engineerText = `ENGINEER-${proof}: Keep the first release small. Record this feedback in direction.txt and update the scope Plan item, preserving the other contributors' feedback and source references.`;
  const qaText = `QA-${proof}: Include everyone who has access. Record this feedback in direction.txt and update the access Plan item, preserving the other contributors' feedback and source references.`;
  const designBody = { text: designText, target: { kind: 'browser', id: capture.id, anchor: { type: 'element', id: element.id } } };
  const submitted = Date.now();
  await feedback(designer, designBody, 'design');
  const designed = await activity(); const thread = designed.workspace_threads[0]!; assert(thread);
  const designMessage = designed.inputs.find(input => input.workspace?.thread_id === thread.id)?.message_ids[0];
  assert(designMessage, 'Accepted Designer feedback must expose its saved message ID');
  await Promise.all([
    feedback(engineer, { text: engineerText, thread_id: thread.id, reply_to: designMessage }, 'engineering'),
    feedback(qa, { text: qaText, target: { kind: 'browser', id: capture.id, anchor: { type: 'region', x: .1, y: .1, width: .6, height: .3 } } }, 'qa'),
  ]);
  await feedback(designer, designBody, 'design');
  const accepted = await until(activity, value => value.workspace_threads.flatMap(thread => thread.comments).length === 3, 20_000);
  const comments = accepted.workspace_threads.flatMap(thread => thread.comments);
  assert.equal(new Set(comments.map(comment => comment.actor.subject)).size, 3);
  assert.deepEqual(new Set(comments.map(comment => comment.actor.subject)), new Set([designer.subject, engineer.subject, qa.subject]));
  assert.equal(new Set(comments.map(comment => comment.participant?.color)).size, 3);
  for (const thread of accepted.workspace_threads) {
    assert(thread.target.image_available);
    assert.equal(thread.target.image, undefined);
    const response = await request(viewer, `/rat/sessions/${sessionId}/workspace/threads/${thread.id}/image`);
    assert(response.ok);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(capture.frame.image, 'base64'));
  }
  await until(async () => watches.map(watch => watch.latest()), values => values.every(value => value?.workspace_threads.flatMap(thread => thread.comments).length === 3), 20_000);
  timings.feedback_visible_to_everyone = Date.now() - submitted;
  watches.forEach(watch => watch.assertOpen());
  check('Element, reply and region annotations propagate to three live streams with unique identity colors and idempotency');
  assert(accepted.inputs.some(input => input.reply?.message_id === designMessage && input.workspace?.thread_id === thread.id));
  assert.equal(accepted.workspace_threads.find(value => value.id === thread.id)?.target.anchor.type, 'element');
  check('Reply and captured element context are saved in one attributed receipt after the live page moves');
  const final = await until(activity, value => settled(value) && acknowledgedFeedback(assistantText(value), proof, visualCode), 5 * 60_000);
  check('Real agent acknowledged all three attributed annotation markers and read the visual-only code from the capture');
  // The saved workspace target supplies the exact image sent with the attributed feedback receipt.
  assert(final.inputs.filter(input => input.workspace).every(input => input.status === 'dispatched'));
  check('Feedback was durably dispatched as agent input with captured page context');
  const plan = final.plan;
  assert(plan && plan.revision > originalPlan.revision);
  assert.deepEqual(new Set(plan.items.map(item => item.id)), new Set(['direction', 'scope', 'access']));
  assert(plan.items.every(item => item.state === 'addressed' && item.reason && item.updated_by.agent_id === agentId && final.turns.some(turn => turn.id === item.updated_by.turn_id)));
  const sources = plan.items.flatMap(item => item.source_refs);
  for (const input of final.inputs.filter(input => input.workspace)) {
    assert(input.message_ids.some(id => sources.some(source => source.message_id === id && source.receipt_id === input.id)), 'Each collaborator feedback receipt must be cited by the real agent Plan');
  }
  const results = [...new Map(plan.items.flatMap(item => item.result_links).filter(link => link.kind === 'artifact').map(link => [link.artifact_id, link])).values()];
  assert(results.length > 0 && plan.items.every(item => item.result_links.some(link => link.kind === 'artifact')));
  const savedResults: string[] = [];
  for (const link of results) {
    const response = await request(viewer, `/agents/sessions/${sessionId}/artifacts/${link.artifact_id}/content`);
    assert(response.ok, 'Viewer can read the exact Plan result');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), link.version_sha256);
    savedResults.push(bytes.toString('utf8'));
  }
  assert(savedResults.some(text => ['DESIGN-', 'ENGINEER-', 'QA-'].every(marker => text.includes(`${marker}${proof}`)) && text.includes(visualCode)), 'A saved Plan result must contain the accumulated feedback and visual-only code');
  const history = await json<{ revisions: SessionPlan[]; head_revision: number }>(viewer, `/rat/sessions/${sessionId}/plan/revisions?after=0&limit=50`);
  assert.equal(history.head_revision, plan.revision);
  assert.deepEqual(history.revisions.find(revision => revision.revision === originalPlan.revision), originalPlan);
  assert.deepEqual(history.revisions.at(-1), plan);
  assert(history.revisions.every((revision, index) => revision.revision === index + 1));
  await until(async () => watches.map(watch => watch.latest()), values => values.every(value => value?.plan?.revision === plan.revision), 15_000);
  evidence.plan = plan; evidence.plan_history = history;
  timings.feedback_to_plan_visible = Date.now() - submitted;
  check('Live agent Plan cites all three receipts, links exact hashed results, preserves immutable history and reaches every stream');
  for (const [person, path, method, body] of [
    [viewer, `/rat/sessions/${sessionId}/workspace/feedback`, 'POST', designBody],
    [viewer, `/rat/sessions/${sessionId}/workspace/browser`, 'POST', { epoch: moved.epoch, revision: moved.revision, operation: { action: 'reload' } }],
    [outsider, `/rat/sessions/${sessionId}/activity`, 'GET', undefined],
    [viewer, `/rat/sessions/${sessionId}/plan/revisions`, 'POST', { expected_revision: plan.revision, items: [] }],
  ] as const) { const denied = await request(person, path, method, body, 'forbidden'); assert([403, 404].includes(denied.status)); await denied.body?.cancel(); }
  assert.equal((await getFrame(viewer)).epoch, moved.epoch);
  check('Viewer can follow but cannot annotate or navigate; outsider cannot read');
  const replay = watchActivity(baseURL, spaceId, sessionId, await engineer.accessTokenForRequest(), initial.cursor); watches.push(replay); await replay.ready;
  await until(async () => replay.latest(), value => value?.workspace_threads.flatMap(thread => thread.comments).length === 3 && value.plan?.revision === plan.revision, 15_000);
  assert.deepEqual(replay.latest()!.workspace_threads[0]!.target, accepted.workspace_threads[0]!.target);
  const replayImage = await request(engineer, `/rat/sessions/${sessionId}/workspace/threads/${thread.id}/image`);
  assert(replayImage.ok);
  assert.deepEqual(Buffer.from(await replayImage.arrayBuffer()), Buffer.from(capture.frame.image, 'base64'));
  check('Reconnect replays durable annotations and their original captured image');
  const qaActor = await json<{ actor: { id: string } }>(qa, '/rat/me');
  await json(designer, `/rat/spaces/${spaceId}/bindings/${encodeURIComponent(qaActor.actor.id)}`, 'DELETE');
  const revokedAt = Date.now();
  await Promise.race([watches[2]!.done, delay(8_000).then(() => { throw new Error('Revoked stream did not close within eight seconds'); })]);
  timings.revocation_stream_close = Date.now() - revokedAt;
  const denied = await request(qa, `/rat/sessions/${sessionId}/workspace/browser`); assert([403, 404].includes(denied.status)); await denied.body?.cancel();
  replay.assertOpen(); check('Revocation closes the existing stream and denies browser access');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1; console.error(evidence.error);
} finally {
  await Promise.all(watches.map(watch => watch.stop()));
  if (last) {
    evidence.assistant_text = assistantText(last);
    evidence.final_plan = last.plan;
    evidence.plan_tool_items = last.items.filter(item => item.type === 'function_call' || item.type === 'function_call_output');
    evidence.browser_tool_text = last.items.flatMap(item => item.type === 'mcp_call' ? [{ name: item.name, status: item.status, output: browserOutputText(item.output).slice(0, 2000) }] : []);
    evidence.turns = last.turns.map(turn => ({ id: turn.id, status: turn.status, error: turn.error, usage: turn.usage }));
    const usage = aggregateUsage(last);
    evidence.usage = usage; evidence.estimated_inference_usd = (usage.input * .22 + usage.output * 1.32) / 1_000_000;
    evidence.estimate_note = 'Conservative uncached short-context token estimate; infrastructure excluded, not an AWS invoice.';
    evidence.threads = last.workspace_threads;
    evidence.item_summary = last.items.map(item => ({ type: item.type, id: item.id, ...(item.type === 'mcp_call' ? { name: item.name, server_label: item.server_label, status: item.status, error: item.error } : {}) }));
  }
  const cleanupErrors: string[] = [];
  try { if (sessionId) await client().beta.agents.sessions.delete(sessionId); } catch { cleanupErrors.push('Session deletion failed; destroy stack'); }
  try { if (agentId) await client().beta.agents.delete(agentId); } catch { cleanupErrors.push('Agent deletion failed; destroy stack'); }
  try { await identities.close(); } catch { cleanupErrors.push('Identity removal failed; destroy stack'); }
  if (cleanupErrors.length) { evidence.status = 'failed'; process.exitCode = 1; }
  evidence.cleanup_errors = cleanupErrors; evidence.finished_at = new Date().toISOString();
  await writeFile(`${directory}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: evidence.status, output: directory, estimated_inference_usd: evidence.estimated_inference_usd, cleanup_errors: cleanupErrors }));
}

function browserOutputText(output: unknown): string {
  if (!output || typeof output !== 'object' || !('content' in output) || !Array.isArray(output.content)) return '[No structured browser output]';
  return output.content.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}
function assistantText(activity: Activity): string { return activity.items.flatMap(item => item.type === 'message' && item.role === 'assistant' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n'); }
function settled(activity: Activity): boolean { return activity.turns.length > 0 && activity.turns.every(turn => turn.status === 'completed') && activity.inputs.every(input => input.status === 'dispatched'); }
function aggregateUsage(activity: Activity) { return activity.turns.reduce((total, turn) => ({ input: total.input + (turn.usage?.input_tokens ?? 0), output: total.output + (turn.usage?.output_tokens ?? 0) }), { input: 0, output: 0 }); }
function enforceBudget(activity: Activity): void {
  const usage = aggregateUsage(activity);
  assert(!stopRequested, 'Scenario stopped by operator');
  assert(Date.now() < deadline, 'Scenario runtime budget reached');
  assert(activity.turns.length <= 4, 'Turn budget reached');
  assert(usage.input + usage.output <= 250_000, 'Observed token budget reached');
  assert(priorInferenceUsd + (usage.input * .22 + usage.output * 1.32) / 1_000_000 < 1, 'Aggregate inference spend budget reached');
  assert(activity.items.filter(item => !['message', 'reasoning'].includes(item.type)).length <= 20, 'Tool call budget reached');
  const failed = activity.turns.find(turn => ['failed', 'cancelled'].includes(turn.status));
  assert(!failed, `Turn failed: ${JSON.stringify(failed?.error)}`);
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout: number): Promise<T> {
  const until = Math.min(deadline, Date.now() + timeout);
  do { const value = await read(); if (done(value)) return value; await delay(500); } while (Date.now() < until);
  throw new Error('Timed out waiting for live proof condition');
}
function watchActivity(baseURL: string, spaceId: string, sessionId: string, token: string, cursor: string) {
  const controller = new AbortController(); let latest: Activity | undefined; let failure: unknown; let settled = false;
  const connectTimer = setTimeout(() => controller.abort(), 30_000);
  const ready = fetch(`${baseURL}/rat/sessions/${sessionId}/activity/events`, { headers: { authorization: `Bearer ${token}`, 'X-Rat-Space': spaceId, 'Last-Event-ID': cursor }, signal: controller.signal, redirect: 'error' })
    .then(response => { clearTimeout(connectTimer); assert(response.ok && response.body, `Stream returned ${response.status}`); return response; }, error => { clearTimeout(connectTimer); throw error; });
  const done = (async () => {
    try { const response = await ready; const reader = response.body!.getReader(); const decoder = new TextDecoder(); let pending = '';
      try { while (!controller.signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n'); let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') { const event = JSON.parse(data) as { activity?: Activity }; if (event.activity) latest = event.activity; }
        }
      } } finally { await reader.cancel().catch(() => undefined); }
    } catch (error) { if (!controller.signal.aborted) failure = error; } finally { settled = true; }
  })();
  return { ready, done, latest: () => latest, assertOpen: () => { if (failure) throw failure; assert(!settled, 'Live stream closed unexpectedly'); }, stop: async () => { controller.abort(); await done; } };
}
