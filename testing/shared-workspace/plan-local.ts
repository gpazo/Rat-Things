import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { localWorkerNames } from '../../src/domain/local-runtime.js';
import { sharedBrowserTool } from '../../src/domain/shared-browser.js';
import type { SessionCaller } from '../../src/core/session-caller.js';

const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 20;
const MAX_TOKENS = 250_000;
const MAX_RUNTIME_MS = 20 * 60_000;
const OUTPUT_PATH = '/workspace/outputs/shared-feedback-summary.md';
const EXPECTED_MODEL = 'gpt-6-luna';
const startedAt = Date.now();
const deadline = startedAt + MAX_RUNTIME_MS;

interface ProofEvidence {
  version: 1;
  status: 'running' | 'passed' | 'failed';
  inference: string;
  runtime: string;
  model: string;
  started_at: string;
  checks: string[];
  timings_ms: Record<string, number>;
  usage: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; tool_calls: number; accounting: string };
  estimated_inference_cost_usd: null;
  cost_note: string;
  limits: { turns: number; tool_calls: number; observed_tokens: number; runtime_ms: number };
  cleanup: { session_deleted: boolean; worker_container_absent: boolean; worker_volumes_removed: boolean; profile_preserved: true };
  client_kind: string;
  limitations: string[];
  session_id?: string;
  capture?: { id: string; frame_id: string; image_sha256: string; element_id: string; visual_code_sha256: string; visual_code_in_text: false };
  accepted_message_ids?: string[];
  plan?: Record<string, unknown>;
  final_plan?: Record<string, unknown>;
  plan_input?: { id: string; status: string; turn_ids: string[]; message_ids: string[] };
  final_observation?: {
    turns: Array<{ id: string; status: string; usage: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null } }>;
    assistant_text: string[];
    tool_calls: Array<{ turn_id: string; call_id: string; name?: string; arguments?: string; result_text?: string; error_text?: string }>;
  };
  command_events?: number;
  error?: string;
}

assert.equal(process.env.RAT_LIVE_SHARED_PLAN, '1', 'Set RAT_LIVE_SHARED_PLAN=1 to run this bounded live proof.');
const { values } = parseArgs({ options: {
  directory: { type: 'string', default: join(homedir(), '.rat-things/multiplayer-demo') },
  model: { type: 'string' },
  output: { type: 'string', default: 'artifacts/shared-workspace/live-local' },
} });
assert.equal(values.model, EXPECTED_MODEL, `Pass --model ${EXPECTED_MODEL}; this proof has no model fallback.`);

const directory = resolve(values.directory!);
const outputDirectory = resolve(values.output!);
await mkdir(outputDirectory, { recursive: true });
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const proof = `LOCAL-PLAN-${randomUUID()}`;
const marker = `SUMMARY-${randomUUID().slice(0, 8)}`;
const visualCode = `VISUAL-${randomUUID().slice(0, 8)}`;
const checks: string[] = [];
const timings: Record<string, number> = {};
const evidence: ProofEvidence = {
  version: 1,
  status: 'running',
  inference: 'existing ChatGPT subscription',
  runtime: 'LocalSessionExecution with container runtime',
  model: values.model,
  started_at: new Date(startedAt).toISOString(),
  client_kind: 'Direct in-process SessionCaller objects, not OIDC logins or native desktop clients',
  checks,
  timings_ms: timings,
  usage: { input_tokens: null, output_tokens: null, total_tokens: null, tool_calls: 0, accounting: 'waiting for Turn usage' },
  estimated_inference_cost_usd: null,
  cost_note: 'Existing ChatGPT subscription inference; per-run billing is unavailable from this local harness.',
  limits: { turns: MAX_TURNS, tool_calls: MAX_TOOL_CALLS, observed_tokens: MAX_TOKENS, runtime_ms: MAX_RUNTIME_MS },
  cleanup: { session_deleted: false, worker_container_absent: false, worker_volumes_removed: false, profile_preserved: true },
  limitations: ['Single bounded acceptance scenario; not a load benchmark', 'No native desktop UI automation', 'Collaborator identities use direct in-process permissions, not OIDC authentication'],
};
const check = (name: string) => {
  checks.push(name);
  process.stdout.write(`${JSON.stringify({ status: 'progress', check: name, elapsed_ms: Date.now() - startedAt })}\n`);
};
const caller = (id: string, label: string, permissions: string[]): SessionCaller => ({
  actor: { id, kind: 'human', label }, permissions,
});
const designer = caller('designer', 'Designer', ['read', 'contribute']);
const engineer = caller('engineer', 'Engineer', ['read', 'contribute']);
const qa = caller('qa', 'QA', ['read', 'contribute']);
const viewer = caller('viewer', 'Viewer', ['read']);
const commandEvents: unknown[] = [];
const launch = () => createLocalServices({ directory, maxSessions: 1,
  execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 1,
    environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
    request: request => ({ ...request, onEvent: event => {
      if (event.method === 'item/commandExecution/outputDelta') {
        commandEvents.push({ method: event.method, output_bytes: typeof event.params.delta === 'string' ? Buffer.byteLength(event.params.delta) : null });
      }
      if (event.method === 'item/completed' || event.method === 'item/started') {
        const item = event.params.item as Record<string, unknown> | undefined;
        if (item?.type === 'commandExecution' || item?.type === 'mcpCall' || item?.type === 'functionCall') {
          commandEvents.push({ method: event.method, type: item.type, status: item.status });
        }
      }
    } }),
  }),
});

let services = launch();
let sessionId: string | undefined;
let deleted = true;
let absentContainer = true;
let removedVolumes = true;
let cleanupError: string | undefined;

const assertBudget = async () => {
  assert(Date.now() <= deadline, 'The twenty-minute wall-clock budget expired.');
  const turns = sessionId ? (await services.sessions.turns(LOCAL_OWNER, sessionId)).data : [];
  assert(turns.length <= MAX_TURNS, `Turn budget exceeded: ${turns.length}`);
  const items = sessionId ? (await services.sessions.items(LOCAL_OWNER, sessionId, { limit: 100 })).data : [];
  const toolCalls = items.filter(item => ['command_execution', 'mcp_call', 'function_call', 'tool_call'].includes(item.type)).length;
  assert(toolCalls <= MAX_TOOL_CALLS, `Tool-call budget exceeded: ${toolCalls}`);
  const usage = turns.reduce((sum, turn) => {
    const detail = (turn as typeof turn & { usage?: Record<string, unknown> }).usage;
    const inputTokens = number(detail?.input_tokens);
    const outputTokens = number(detail?.output_tokens);
    const totalTokens = number(detail?.total_tokens);
    return {
      input_tokens: sum.input_tokens + inputTokens,
      output_tokens: sum.output_tokens + outputTokens,
      total_tokens: sum.total_tokens + (totalTokens || inputTokens + outputTokens),
      observed: sum.observed || inputTokens > 0 || outputTokens > 0 || totalTokens > 0,
    };
  }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, observed: false });
  if (usage.observed) assert(usage.total_tokens <= MAX_TOKENS, `Observed token budget exceeded: ${usage.total_tokens}`);
  evidence.usage = { input_tokens: usage.observed ? usage.input_tokens : null,
    output_tokens: usage.observed ? usage.output_tokens : null, total_tokens: usage.observed ? usage.total_tokens : null,
    tool_calls: toolCalls, accounting: usage.observed
      ? turns.some(turn => !['completed', 'failed', 'cancelled'].includes(turn.status))
        ? 'reported by Turns; active-Turn usage may be partial' : 'reported by Turns'
      : 'not reported by this local runtime' };
  return { turns, items, toolCalls, usage };
};

const waitForTurn = async (previousCount: number) => {
  while (Date.now() <= deadline) {
    const snapshot = await assertBudget();
    if (snapshot.turns.length > previousCount) {
      const newTurns = snapshot.turns.slice(previousCount);
      const failed = newTurns.find(turn => turn.status === 'failed' || turn.status === 'cancelled');
      if (failed) throw new Error(`Turn ${failed.status}: ${failed.error?.code ?? 'unknown'}`);
      const turn = newTurns.at(-1)!;
      if (newTurns.every(entry => entry.status === 'completed')) return turn;
      if (!timings.first_observed_progress) timings.first_observed_progress = Date.now() - startedAt;
    }
    await delay(250);
  }
  throw new Error('Turn did not complete within the twenty-minute proof deadline.');
};

const waitForPlanReceipt = async (previousReceiptIds: ReadonlySet<string>, previousMessageIds: ReadonlySet<string>) => {
  let receiptId: string | undefined;
  while (Date.now() <= deadline) {
    const snapshot = await assertBudget();
    const activity = await services.sessions.activity(LOCAL_OWNER, sessionId!, designer);
    const receipt = activity.inputs.find(input => !previousReceiptIds.has(input.id)
      && input.actor.id === designer.actor.id && !input.workspace
      && input.message_ids.some(id => !previousMessageIds.has(id)));
    if (receipt) {
      if (receiptId && receipt.id !== receiptId) throw new Error('More than one new Designer input receipt appeared during the Plan proof.');
      receiptId = receipt.id;
      evidence.plan_input = { id: receipt.id, status: receipt.status, turn_ids: [...receipt.turn_ids], message_ids: [...receipt.message_ids] };
      if (receipt.status === 'failed') throw new Error('The Plan instruction receipt failed before delivery.');
      const turnIds = [...new Set(receipt.turn_ids)];
      if (receipt.status === 'dispatched' && turnIds.length > 0) {
        const targetTurns = await Promise.all(turnIds.map(id => services.sessions.turn(LOCAL_OWNER, sessionId!, id)));
        const failed = targetTurns.find(turn => turn.status === 'failed' || turn.status === 'cancelled');
        if (failed) throw new Error(`Turn ${failed.status}: ${failed.error?.code ?? 'unknown'}`);
        if (targetTurns.every(turn => turn.status === 'completed')
          && activity.session.required_actions.length === 0 && (activity.pending_inputs ?? []).length === 0) {
          const primary = targetTurns.at(-1);
          if (!primary) throw new Error('The Plan instruction receipt has no bound Turn.');
          return primary;
        }
        if (!timings.first_observed_progress && targetTurns.some(turn => turn.status === 'in_progress')) timings.first_observed_progress = Date.now() - startedAt;
      }
    }
    if (!timings.first_observed_progress && snapshot.turns.some(turn => turn.status === 'in_progress')) timings.first_observed_progress = Date.now() - startedAt;
    await delay(250);
  }
  throw new Error('The accepted Plan instruction receipt and its bound Turns did not complete within the proof deadline.');
};

const saveFinalObservation = async () => {
  if (!sessionId) return;
  try {
    const [activity, turns, items] = await Promise.all([
      services.sessions.activity(LOCAL_OWNER, sessionId, designer),
      services.sessions.turns(LOCAL_OWNER, sessionId, { limit: MAX_TURNS }),
      services.sessions.items(LOCAL_OWNER, sessionId, { limit: 100 }),
    ]);
    if (activity.plan) evidence.final_plan = activity.plan as unknown as Record<string, unknown>;
    if (!evidence.plan_input) {
      const newReceipt = activity.inputs.find(input => input.actor.id === designer.actor.id && !input.workspace);
      if (newReceipt) evidence.plan_input = { id: newReceipt.id, status: newReceipt.status, turn_ids: [...newReceipt.turn_ids], message_ids: [...newReceipt.message_ids] };
    }
    const messages: string[] = [];
    const toolCalls: NonNullable<ProofEvidence['final_observation']>['tool_calls'] = [];
    for (const item of items.data) {
      const value = item as unknown as Record<string, unknown>;
      if (value.type === 'message' && value.role === 'assistant' && Array.isArray(value.content)) {
        for (const part of value.content) if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'output_text') {
          messages.push(sanitizedText((part as Record<string, unknown>).text));
        }
      } else if (value.type === 'function_call') {
        toolCalls.push({ turn_id: String(value.turn_id ?? ''), call_id: String(value.call_id ?? ''),
          ...(typeof value.name === 'string' ? { name: value.name } : {}), arguments: sanitizedText(value.arguments) });
      } else if (value.type === 'function_call_output') {
        toolCalls.push({ turn_id: String(value.turn_id ?? ''), call_id: String(value.call_id ?? ''),
          result_text: sanitizedText(value.output), ...(value.error ? { error_text: sanitizedText(value.error) } : {}) });
      }
    }
    evidence.final_observation = { turns: turns.data.map(turn => ({ id: turn.id, status: turn.status,
      usage: { input_tokens: number(turn.usage?.input_tokens) || null, output_tokens: number(turn.usage?.output_tokens) || null,
        total_tokens: number(turn.usage?.total_tokens) || null } })), assistant_text: messages, tool_calls: toolCalls };
  } catch (error) {
    evidence.error ??= `Could not save final Session observations: ${error instanceof Error ? sanitizedText(error.message).slice(0, 200) : 'unknown error'}`;
  }
};

try {
  // Status is deliberately reduced to booleans; account identifiers and credentials stay private.
  const status = await services.subscription.status();
  assert(status.signed_in && status.account_type === 'chatgpt', 'The selected profile is not signed in to ChatGPT.');
  const catalog = await services.models();
  assert(catalog?.data.some(model => model.id === values.model), `The selected model ${values.model} is not in the local subscription catalog.`);
  assert((await services.runtimeStatus()).ready, 'The selected local container runtime is not ready.');
  check('Existing subscription sign-in, explicit model, and local runtime are available');

  const session = await services.sessions.create(LOCAL_OWNER, {
    metadata: { rat_things_runtime: 'codex' },
    agent: { model: values.model!, reasoning: { effort: 'low' }, multi_agent: { enabled: false }, tools: [sharedBrowserTool] },
    environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [{ type: 'inline', path: '/workspace/outputs/index.html', data: Buffer.from(`<title>${proof}</title><main><h1>${proof}</h1><p>One workspace for design, engineering, and quality.</p><button style="position:absolute;left:120px;top:160px;width:420px;height:180px">Shared direction</button><p>Ready</p><input aria-label="Visual code" style="position:absolute;left:64px;top:520px;width:600px;height:50px;font:32px sans-serif" placeholder="Visual code"></main>`).toString('base64') }] },
    input: `Use the rat_shared_browser browser to snapshot and navigate to https://rat-artifacts.invalid/index.html. Confirm the title ${proof}. Then write ${OUTPUT_PATH} containing a concise summary with the marker ${marker}. Use at most three tool calls.`,
  }, undefined, undefined, undefined, designer);
  sessionId = session.id;
  deleted = false;
  absentContainer = false;
  removedVolumes = false;
  evidence.session_id = sessionId;
  const submitStarted = Date.now();
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  timings.initial_turn_submit = Date.now() - submitStarted;
  await waitForTurn(0);
  const initialFrame = await services.sessions.browserFrame(LOCAL_OWNER, session.id, designer);
  assert.equal(initialFrame.title, proof);
  assert(initialFrame.elements?.length, 'The live page must expose selectable browser elements.');
  let annotatedFrame = await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: initialFrame.epoch, revision: initialFrame.revision, operation: { action: 'click', x: .12, y: .68 } }, designer, 'focus-visual-code');
  annotatedFrame = await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: annotatedFrame.epoch, revision: annotatedFrame.revision, operation: { action: 'type', text: visualCode } }, designer, 'type-visual-code');
  assert(!annotatedFrame.text.includes(visualCode), 'The visual code must stay out of browser text and feedback.');
  const selectable = annotatedFrame.elements?.find(element => element.text.toLowerCase().includes('shared direction')) ?? annotatedFrame.elements?.[0];
  assert(selectable, 'The captured frame must expose a selectable browser element.');
  const capture = await services.sessions.captureBrowser(LOCAL_OWNER, session.id, { frame_id: annotatedFrame.frame_id }, designer);
  await writeFile(join(outputDirectory, 'captured-browser.jpg'), Buffer.from(capture.frame.image, 'base64'));
  assert(!capture.frame.text.includes(visualCode), 'The captured browser text must not expose the visual-only code.');
  evidence.capture = { id: capture.id, frame_id: capture.frame.frame_id,
    image_sha256: createHash('sha256').update(capture.frame.image).digest('hex'), element_id: selectable.id,
    visual_code_sha256: createHash('sha256').update(visualCode).digest('hex'), visual_code_in_text: false };
  check('Real isolated worker rendered the page and saved an immutable browser capture');

  const elementFeedback = { text: `DESIGN-${proof}: Keep the shared direction easy to scan.`, target: { kind: 'browser', id: capture.id, anchor: { type: 'element', id: selectable.id } } };
  const regionFeedback = { text: `ENGINEERING-${proof}: Keep the first release small.`, target: { kind: 'browser', id: capture.id, anchor: { type: 'region', x: .08, y: .08, width: .62, height: .3 } } };
  const commentStarted = Date.now();
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, elementFeedback, designer, 'designer-element');
  const acceptedOne = await services.sessions.activity(LOCAL_OWNER, session.id, designer);
  const threadId = acceptedOne.workspace_threads.find(thread => thread.comments[0]?.actor.id === 'designer')?.id;
  assert(threadId, 'Designer feedback was not accepted.');
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, { text: `QA-${proof}: Keep the captured page readable.`, target: { kind: 'browser', id: capture.id, anchor: { type: 'region', x: .1, y: .12, width: .4, height: .22 } } }, qa, 'qa-region');
  const designerMessageId = acceptedOne.inputs.find(input => input.workspace && input.actor.id === 'designer')?.message_ids[0];
  assert(designerMessageId, 'Missing the message ID needed for the engineer reply.');
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, { text: `ENGINEER-REPLY-${proof}: Agreed.`, thread_id: threadId, reply_to: designerMessageId }, engineer, 'engineer-reply');
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, regionFeedback, engineer, 'engineer-region');
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, elementFeedback, designer, 'designer-element');
  const accepted = await services.sessions.activity(LOCAL_OWNER, session.id, designer);
  const comments = accepted.workspace_threads.flatMap(thread => thread.comments);
  assert(accepted.workspace_threads.some(thread => thread.target.anchor.type === 'element' && thread.comments.some(comment => comment.actor.id === 'designer')));
  assert(accepted.workspace_threads.some(thread => thread.target.anchor.type === 'region' && thread.comments.some(comment => comment.actor.id === 'qa')));
  assert(accepted.inputs.some(input => input.actor.id === 'engineer' && input.reply?.message_id === designerMessageId));
  assert.equal(comments.filter(comment => comment.actor.id === 'designer').length, 1, 'Duplicate delivery must remain idempotent.');
  const participantColors = new Set(comments.filter(comment => ['designer', 'engineer', 'qa'].includes(comment.actor.id))
    .flatMap(comment => comment.participant?.color ? [comment.participant.color] : []));
  assert.equal(participantColors.size, 3, 'Each collaborator must retain a distinct participant color.');
  await assertFrozenCapture(services, session.id, accepted, designer, Buffer.from(capture.frame.image, 'base64'));
  timings.feedback_acceptance = Date.now() - commentStarted;
  const acceptedIds = accepted.inputs.filter(input => input.workspace).flatMap(input => input.message_ids);
  assert(acceptedIds.length >= 4, 'Expected accepted feedback and reply message IDs in the Session activity.');
  evidence.accepted_message_ids = acceptedIds;
  check('Three attributed collaborators added element, region, and reply feedback; duplicate delivery was idempotent');

  const beforeMove = await services.sessions.browserFrame(LOCAL_OWNER, session.id, engineer);
  const afterCaptureURL = 'https://rat-artifacts.invalid/index.html?after-capture';
  const moved = await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: beforeMove.epoch, revision: beforeMove.revision,
    operation: { action: 'navigate', url: afterCaptureURL } }, engineer, 'move-live-browser');
  assert.equal(moved.url, afterCaptureURL);
  assert(!moved.text.includes(visualCode), 'The new page must not retain the visual-only code.');
  assert(moved.revision > capture.frame.revision);
  const persisted = await services.sessions.activity(LOCAL_OWNER, session.id, designer);
  await assertFrozenCapture(services, session.id, persisted, designer, Buffer.from(capture.frame.image, 'base64'));
  const denial = await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, { text: 'Viewer must be denied.', target: { kind: 'browser', id: capture.id, anchor: { type: 'region', x: 0, y: 0, width: .1, height: .1 } } }, viewer, 'viewer-denied').then(() => false, () => true);
  assert(denial, 'Viewer unexpectedly contributed feedback.');
  check('Browser movement left the frozen capture unchanged and the viewer could not contribute');

  const instruction = `Use the reserved rat_things_plan_update function as the root agent. First read the visual code from the attached captured page image. Then write ${OUTPUT_PATH} with the exact code you see, the summary marker ${marker}, and the three accepted feedback markers DESIGN-${proof}, ENGINEERING-${proof}, and QA-${proof}. Update the Plan to one next item summarizing the accepted design, engineering, and QA feedback. Cite these accepted message IDs exactly: ${acceptedIds.join(', ')}. Include the literal output path ${OUTPUT_PATH} as a result link (kind output). Set expected_revision to 0. Do not claim the item is complete. Keep your response brief.`;
  const beforePlanActivity = await services.sessions.activity(LOCAL_OWNER, session.id, designer);
  const beforePlanReceiptIds = new Set(beforePlanActivity.inputs.map(input => input.id));
  const beforePlanMessageIds = new Set(beforePlanActivity.inputs.flatMap(input => input.message_ids));
  const planStarted = Date.now();
  await services.sessions.message(LOCAL_OWNER, session.id, { text: instruction }, designer, 'plan-instruction');
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  timings.plan_turn_submit = Date.now() - planStarted;
  const planTurn = await waitForPlanReceipt(beforePlanReceiptIds, beforePlanMessageIds);
  timings.plan_turn_complete = Date.now() - planStarted;
  const activity = await services.sessions.activity(LOCAL_OWNER, session.id, designer) as typeof accepted & { plan?: { revision: number; items: Array<Record<string, unknown>> } };
  assert(activity.plan && activity.plan.revision === 1 && activity.plan.items.length === 1, 'The root agent did not commit Plan revision 1.');
  const item = activity.plan.items[0]!;
  assert(item.state === 'next');
  const sourceRefs = item.source_refs as Array<{ receipt_id: string; message_id: string }>;
  assert(acceptedIds.every(id => sourceRefs.some(reference => reference.message_id === id)), 'Plan source refs must include each accepted feedback message ID.');
  const acceptedSources = accepted.inputs.filter(input => input.workspace).flatMap(input => input.message_ids.map(message_id => ({ receipt_id: input.id, message_id })));
  assert(acceptedSources.every(source => sourceRefs.some(reference => reference.receipt_id === source.receipt_id && reference.message_id === source.message_id)),
    'Plan must preserve the exact receipt and message ID pair for every accepted feedback message.');
  assert((item.updated_by as { agent_id?: string; turn_id?: string }).agent_id === session.agent.id
    && (item.updated_by as { turn_id?: string }).turn_id === planTurn.id, 'Plan must be written by this Session root agent and its observed Turn.');
  const resultLinks = item.result_links as Array<{ kind: string; artifact_id?: string; version_sha256?: string }>;
  const artifactLink = resultLinks.find(link => link.kind === 'artifact');
  assert(artifactLink?.artifact_id && /^[a-f0-9]{64}$/.test(artifactLink.version_sha256 ?? ''), 'Plan must resolve the exact output path to a saved artifact/version link.');
  const artifactPage = await services.sessions.artifacts(LOCAL_OWNER, session.id, { limit: 100 });
  assert(artifactPage.data.some(entry => entry.id === artifactLink.artifact_id && entry.path === OUTPUT_PATH), 'The Plan artifact link must match the saved output path.');
  const artifactStream = await services.sessions.artifactContent(LOCAL_OWNER, session.id, artifactLink.artifact_id);
  const artifactBytes = await readAll(artifactStream);
  assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), artifactLink.version_sha256, 'Saved output bytes must match the Plan artifact version hash.');
  const savedOutput = new TextDecoder('utf-8', { fatal: true }).decode(artifactBytes);
  for (const expected of [marker, visualCode, `DESIGN-${proof}`, `ENGINEERING-${proof}`, `QA-${proof}`]) {
    assert(savedOutput.includes(expected), `Saved output is missing ${expected.startsWith('VISUAL-') ? 'the visual code' : 'a required feedback marker'}.`);
  }
  assert((await services.sessions.items(LOCAL_OWNER, session.id, { limit: 100 })).data.some(entry => entry.turn_id === planTurn.id), 'The Plan update must come from the observed root Turn.');
  timings.plan_visible = Date.now() - planStarted;
  const history = await services.sessions.planRevisions(LOCAL_OWNER, session.id, { after: 0, limit: 50 }, designer);
  assert.equal(history.head_revision, 1);
  assert.deepEqual(history.revisions.map(revision => revision.revision), [1]);
  assert.deepEqual(history.revisions[0]?.items, activity.plan.items);
  evidence.plan = { revision: activity.plan.revision, item_id: item.id, source_refs: sourceRefs,
    result_links: resultLinks, output_path: OUTPUT_PATH, output_bytes: artifactBytes.byteLength,
    output_sha256: createHash('sha256').update(artifactBytes).digest('hex'), root_turn_id: planTurn.id,
    history_revisions: history.revisions.map(revision => revision.revision) };
  check('Root agent committed an attributed Plan with a captured artifact link and immutable revision history');

  await services.close();
  services = launch();
  const restored = await services.sessions.activity(LOCAL_OWNER, session.id, designer) as typeof activity;
  assert.deepEqual(restored.plan, activity.plan);
  assert.equal(restored.workspace_threads.flatMap(thread => thread.comments).length, comments.length);
  await assertFrozenCapture(services, session.id, restored, designer, Buffer.from(capture.frame.image, 'base64'));
  const restoredHistory = await services.sessions.planRevisions(LOCAL_OWNER, session.id, { after: 0, limit: 50 }, designer);
  assert.deepEqual(restoredHistory.revisions, history.revisions);
  const restoredBytes = await readAll(await services.sessions.artifactContent(LOCAL_OWNER, session.id, artifactLink.artifact_id));
  assert.deepEqual(restoredBytes, artifactBytes, 'Saved output bytes must survive the graceful service restart.');
  check('Graceful service restart preserved the Plan, history, attribution, and captured context');
  timings.total = Date.now() - startedAt;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? sanitizedText(error.message).slice(0, 500) : 'Unknown failure';
  throw error;
} finally {
  await saveFinalObservation();
  const writeEvidence = () => writeFile(join(outputDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  try { await writeEvidence(); } catch { /* The final post-cleanup write retries evidence persistence. */ }
  try {
    if (sessionId) {
      await services.sessions.delete(LOCAL_OWNER, sessionId);
      deleted = true;
    }
  } catch (error) { cleanupError = error instanceof Error ? error.message.slice(0, 200) : 'Session deletion failed'; }
  try { await services.close(); } catch { /* Evidence records cleanup status. */ }
  if (sessionId) {
    const worker = localWorkerNames(workspaceId, sessionId);
    try {
      const run = promisify(execFile);
      const containers = (await run('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30_000 })).stdout.split(/\r?\n/);
      if (containers.includes(worker.name)) await run('docker', ['rm', '--force', worker.name], { timeout: 30_000 });
      absentContainer = !(await run('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30_000 })).stdout.split(/\r?\n/).includes(worker.name);
      const volumes = [worker.volume, `${worker.volume}-state`];
      const present = (await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 30_000 })).stdout.split(/\r?\n/).filter(name => volumes.includes(name));
      if (present.length) await run('docker', ['volume', 'rm', ...present], { timeout: 30_000 });
      const remaining = (await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 30_000 })).stdout.split(/\r?\n/).filter(name => volumes.includes(name));
      removedVolumes = remaining.length === 0;
      if (!absentContainer || !removedVolumes) cleanupError = 'A worker container or volume remains after cleanup.';
    } catch (error) {
      cleanupError = error instanceof Error ? error.message.slice(0, 200) : 'Worker cleanup failed';
    }
  }
  evidence.cleanup = { session_deleted: deleted, worker_container_absent: absentContainer, worker_volumes_removed: removedVolumes, profile_preserved: true };
  evidence.command_events = commandEvents.length;
  if (!deleted || !absentContainer || !removedVolumes) {
    evidence.status = 'failed';
    evidence.error = cleanupError ?? 'Local Session or worker volume cleanup did not complete.';
    process.exitCode = 1;
  }
  await writeEvidence();
  process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: join(outputDirectory, 'evidence.json'), cleanup: evidence.cleanup })}\n`);
}

function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }

function sanitizedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return String(text)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[redacted image data]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted cloud credential]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 4_000);
}

async function assertFrozenCapture(services: ReturnType<typeof launch>, sessionId: string, activity: Awaited<ReturnType<typeof services.sessions.activity>>,
  caller: SessionCaller, expected: Uint8Array): Promise<void> {
  for (const thread of activity.workspace_threads) {
    assert.equal(thread.target.image_available, true, 'Activity must advertise the saved capture image.');
    const image = await services.sessions.workspaceThreadImage(LOCAL_OWNER, sessionId, thread.id, caller);
    assert.deepEqual(Buffer.from(image.bytes), Buffer.from(expected), 'Annotation image must remain the immutable captured frame.');
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try { while (true) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
