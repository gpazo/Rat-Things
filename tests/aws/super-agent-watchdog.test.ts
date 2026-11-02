import { it } from 'vitest';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import type { SessionState, SessionTurnBinding } from '../../src/core/session-ports.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { StoredEnvironment } from '../../src/core/environment-service.js';
import type { WatchdogCandidate, WatchdogFinding } from '../../src/domain/watchdog.js';
import type { WebhookDelivery, WebhookEndpoint } from '../../src/domain/session-webhooks.js';
import { parseWatchdogVerdict, watchdogIdentity } from '../../src/core/watchdog-planning.js';
import { assistantText, check, eventually, hash, proofTimeout, required, SecurityProof } from '../../testing/aws/super-security-proof.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUPER_AGENT_PROOF === 'true' ? it : it.skip;

live('reports injected held work, completes one real retry, and judges with a real model while the outbox consumer is paused', async () => {
  const proof = new SecurityProof();
  let endpointId: string | undefined;
  let succeeded = false;
  try {
    await proof.validate();
    await proof.pauseOutbox();
    const endpoint = await proof.client.post<WebhookEndpoint>('/webhooks', { body: {
      name: proof.proofId, url: required('AWS_E2E_WEBHOOK_CAPTURE_URL'), events: ['agent.session.watchdog'],
    } });
    endpointId = endpoint.id;

    const held = await seed('queued');
    const candidate: WatchdogCandidate = { ownerId: proof.owner, sessionId: held.session.id, subjectId: held.session.id, reason: 'outbox_stuck', since: held.turns[0]!.turn.created_at };
    const heldId = watchdogIdentity(candidate);
    await eventually('scheduled deployed held-work report', async () => {
      const finding = await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', heldId);
      return finding?.value.reportedVersion === 1;
    });
    const reported = (await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', heldId))!;
    check(reported.value.candidate.reason === 'outbox_stuck' && reported.value.judge.status === 'skipped' && reported.value.retry === 'not_applicable' && reported.value.cancel === 'not_requested', 'deterministic held-work finding');
    check(reported.value.reportVersion === 1 && reported.value.reportedVersion === 1 && reported.value.reportLeaseUntil === 0, 'held-work report lease settled');
    check(reported.expiresAt && reported.expiresAt > reported.createdAt && reported.expiresAt <= reported.createdAt + 31 * 86400, 'bounded finding retention');
    await reports(heldId, reported.value);
    await proof.revisit();
    check((await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', heldId))?.value.reportVersion === 1, 'stable held-work finding version');
    const heldDeliveries = (await proof.records<WebhookDelivery>('webhook_deliveries')).filter(value => value.value.endpointId === endpoint.id && value.value.event.id === `evt_${heldId}_1`);
    check(heldDeliveries.length === 1 && heldDeliveries[0]!.value.status === 'delivered', 'one logical held-work webhook delivery');
    const pending = (await proof.state(held.session.id)).value;
    check(Object.values(pending.receipts).length === 1 && Object.values(pending.receipts).every(value => !value.dispatched), 'injected work remains undispatched');
    await proof.mappingState('Disabled');
    proof.evidence.report = { sessionId: held.session.id, findingId: heldId, reportVersion: 1, logicalWebhookDeliveries: heldDeliveries.length, queueConsumer: 'Disabled', trigger: 'scheduled EventBridge tick before any manual invocation', seed: 'injected queued Turn' };

    const failed = await seed('failed');
    const failedTurn = failed.turns[0]!;
    const retryId = watchdogIdentity({ ownerId: proof.owner, sessionId: failed.session.id, subjectId: failed.session.id, turnId: failedTurn.turn.id, reason: 'transient_failure', since: failedTurn.turn.completed_at! });
    const key = `watchdog_${hash(`watchdog-retry:${failedTurn.turn.id}`)}`;
    const expectedTurn = `turn_${hash(key).slice(0, 32)}`;
    await eventually('real overloaded retry completion', async () => {
      await proof.tick();
      const turns = await proof.client.beta.agents.sessions.turns.list(failed.session.id, { limit: 100 });
      const retried = turns.data.find(value => value.id === expectedTurn);
      check(!retried || !['failed', 'cancelled'].includes(retried.status), 'real retry must succeed');
      const runtime = await proof.store.get<StoredSessionRuntime>(proof.owner, 'session_runtime', failed.session.id);
      return retried?.status === 'completed' && runtime?.value.snapshot?.turns.some(value => value.turn.id === expectedTurn && value.turn.status === 'completed') === true;
    });
    const retryState = (await proof.state(failed.session.id)).value;
    const receipt = retryState.receipts[key];
    const retry = retryState.turns.find(value => value.turn.id === expectedTurn)!;
    check(receipt?.dispatched && receipt.commands.length === 1 && receipt.commands[0]?.type === 'start' && receipt.commands[0].turnId === expectedTurn, 'one deterministic dispatched retry command');
    check(retryState.turns.length === 2 && retryState.turns.every(value => value.turn.subagent_id === null), 'exact seed and retry root Turns');
    check(JSON.stringify(retry.input.map(({ role, content }) => ({ role, content }))) === JSON.stringify(failedTurn.input.map(({ role, content }) => ({ role, content }))), 'retry preserves failed input');
    const retryRuntime = (await proof.store.get<StoredSessionRuntime>(proof.owner, 'session_runtime', failed.session.id))!;
    const completedRetry = retryRuntime.value.snapshot!.turns.find(value => value.turn.id === expectedTurn)!;
    const retryText = completedRetry.items.flatMap(item => item.type === 'message' && item.role === 'assistant' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
    check((completedRetry.turn.usage?.total_tokens ?? 0) > 0 && retryText.includes(`${proof.proofId}-retry`), 'actual persisted model retry output and usage');
    const retryFinding = (await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', retryId))!;
    check(retryFinding.value.retry === 'submitted' && retryFinding.value.judge.status === 'skipped', 'transient retry without judge');
    await reports(retryId, retryFinding.value);
    for (let i = 0; i < 2; i++) await proof.revisit();
    const revisited = (await proof.state(failed.session.id)).value;
    check(revisited.turns.length === 2 && Object.keys(revisited.receipts).filter(value => value.startsWith('watchdog_')).join() === key, 'retry remains unique after repeated deployed ticks');
    check((await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', retryId))?.value.reportVersion === retryFinding.value.reportVersion, 'stable retry report version');
    check(!await proof.store.get(proof.owner, 'sessions', `sess_${retryId}_judge`), 'no transient judge Session');
    proof.evidence.retry = { sessionId: failed.session.id, seedTurnId: failedTurn.turn.id, seed: 'injected server_overloaded', retryTurnId: expectedTurn, receiptKey: key, completedRealModelTurns: 1, tokens: completedRetry.turn.usage!.total_tokens, outputSurface: 'persisted runtime snapshot and actual public Turn' };

    const progress = await seed('in_progress');
    let judgeFindingId: string | undefined;
    await eventually('real judge reservation', async () => {
      await proof.tick();
      const findings = (await proof.records<WatchdogFinding>('watchdog_findings')).filter(value => value.value.candidate.sessionId === progress.session.id && value.value.candidate.reason === 'long_running');
      for (const value of findings) {
        check(value.id === watchdogIdentity(value.value.candidate), 'observed long-running window identity');
        if (value.value.judge.status !== 'skipped' && value.value.judge.sessionId) proof.sessions.add(value.value.judge.sessionId);
      }
      judgeFindingId ??= findings.find(value => value.value.judge.status === 'pending' || value.value.judge.status === 'completed')?.id;
      return Boolean(judgeFindingId);
    });
    const judgeId = `sess_${judgeFindingId!}_judge`;
    proof.sessions.add(judgeId);
    await eventually('real judge verdict and updated report', async () => {
      await proof.tick();
      const finding = await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', judgeFindingId!);
      check(finding?.value.judge.status !== 'failed', 'real judge must complete');
      return finding?.value.judge.status === 'completed' && finding.value.reportedVersion === finding.value.reportVersion;
    });
    const judged = (await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', judgeFindingId!))!.value;
    check(judged.judge.status === 'completed' && judged.judge.sessionId === judgeId && judged.reportVersion >= 2, 'completed judge and follow-up report');
    const judge = (await proof.state(judgeId)).value;
    check(judge.session.agent.model === proof.model && judge.session.environment.type === 'none' && judge.session.agent.tools.length === 0 && judge.session.agent.multi_agent?.enabled === false, 'judge fixed no-tools envelope');
    const judgeTurn = judge.turns.at(-1)!;
    check(judgeTurn.turn.status === 'completed' && judgeTurn.turn.subagent_id === null && (judgeTurn.turn.usage?.total_tokens ?? 0) > 0, 'actual root judge Turn and usage');
    check((judgeTurn.savedItems ?? []).every(item => ['message', 'reasoning', 'agent_message'].includes(item.type)), 'zero judge tool calls');
    const verdict = parseWatchdogVerdict(assistantText(judge, judgeTurn.turn.id));
    check(verdict && JSON.stringify(verdict) === JSON.stringify(judged.judge.verdict), 'actual parsed model verdict');
    check(judged.cancel === 'not_requested' && (await proof.state(progress.session.id)).value.turns.every(value => !value.cancelRequested), 'no source cancellation');
    await reports(judgeFindingId!, judged);
    await proof.mappingState('Disabled');
    proof.evidence.judge = { sessionId: progress.session.id, seed: 'injected aged progress', findingId: judgeFindingId, judgeSessionId: judgeId, verdict: verdict.verdict, confidence: verdict.confidence, reportVersion: judged.reportVersion, tokens: judgeTurn.turn.usage!.total_tokens };
    await eventually('complete deployed watchdog scan without errors', async () => {
      const scan = await proof.tick();
      if (scan.partial || scan.errors !== 0) return false;
      proof.evidence.completeScan = scan;
      return true;
    });
    succeeded = true;
  } finally {
    const failures: string[] = [];
    try { await proof.deleteSessions(); } catch { failures.push('owned Session and finding cleanup'); }
    try { if (endpointId) await proof.client.delete(`/webhooks/${endpointId}`); } catch { failures.push('owned webhook cleanup'); }
    try { await proof.restoreOutbox(); } catch { failures.push('outbox mapping restoration'); }
    proof.destroy();
    check(failures.length === 0, failures.join('; '));
    if (succeeded) console.log(JSON.stringify({ proof: 'live-watchdog', status: 'PASS', ...proof.evidence }));
  }

  async function seed(status: 'queued' | 'failed' | 'in_progress'): Promise<SessionState> {
    const session = await proof.client.beta.agents.sessions.create({ agent: { model: proof.model, tools: [], multi_agent: { enabled: false } }, environment: { type: 'openai_hosted' }, metadata: { proof_id: proof.proofId, seed: status } });
    proof.sessions.add(session.id);
    const current = await proof.state(session.id);
    check(current.value.session.status === 'idle' && current.value.turns.length === 0 && Object.keys(current.value.receipts).length === 0 && current.value.session.environment.type === 'openai_hosted' && current.value.session.agent.model === proof.model && current.value.session.metadata?.proof_id === proof.proofId && !current.value.closing && !current.value.forkLock, 'new empty API-owned managed Session before injection');
    check(current.value.session.agent.tools.length === 0 && current.value.session.agent.multi_agent?.enabled === false, 'seed capability envelope');
    const environment = await proof.store.get<StoredEnvironment>(proof.owner, 'environments', current.value.session.environment.id);
    check(environment?.value.sessionId === session.id && environment.value.status === 'pending' && !environment.value.runId && !environment.value.pendingRunId && !environment.value.retired, 'managed seed environment has not started');
    check(!await proof.store.get(proof.owner, 'session_runtime', session.id), 'seed has no execution runtime');
    const now = Math.floor(Date.now() / 1000);
    const at = now - (status === 'queued' ? 310 : status === 'in_progress' ? 1810 : 10);
    const turnId = `turn_${hash(`${proof.proofId}:${status}`).slice(0, 32)}`;
    const input: SessionTurnBinding['input'] = [{ id: `msg_${hash(turnId).slice(0, 32)}`, role: 'user', content: [{ type: 'input_text', text: `Reply exactly ${proof.proofId}-retry. Do not use tools.` }] }];
    const binding: SessionTurnBinding = {
      turn: { id: turnId, object: 'agent.session.turn', session_id: session.id, agent_id: session.agent.id, subagent_id: null, status, created_at: at, started_at: status === 'queued' ? null : at, completed_at: status === 'failed' ? at : null, error: status === 'failed' ? { code: 'server_overloaded', message: 'Injected disposable live proof failure' } : null, usage: null },
      input, savedItems: status === 'in_progress' ? [{ id: `msg_${hash(`${turnId}:progress`).slice(0, 32)}`, type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', turn_id: turnId, content: [{ type: 'output_text', text: 'I am comparing two harmless calculations and checking the intermediate result.' }] }] : [], savedArtifacts: [],
    };
    const next: SessionState = { ...current.value, turns: [binding], receipts: status === 'queued' ? { [proof.proofId]: { digest: hash(turnId), commands: [{ type: 'start', turnId, input }], dispatched: false } } : {} };
    await new SessionEventStore(proof.store).put({ ...current, revision: current.revision + 1, value: next }, current.revision);
    const saved = await proof.state(session.id);
    const observation = await proof.store.get<SessionStreamSnapshot>(proof.owner, 'session_observations', session.id);
    check(saved.createdAt === current.createdAt && saved.value.turns[0]?.turn.status === status && observation?.value.turns[0]?.status === status, 'CAS seed and committed observation');
    check(JSON.stringify(saved.value.session) === JSON.stringify(current.value.session) && JSON.stringify(saved.value.runtime) === JSON.stringify(current.value.runtime) && saved.value.placement === current.value.placement, 'seed preserves API-created Session and execution envelope');
    return saved.value;
  }
  async function reports(id: string, finding: WatchdogFinding): Promise<void> {
    const version = `${id}_${finding.reportVersion}`;
    await eventually('Teams finding capture', async () => {
      const values = await proof.capture(body => body.includes(`Finding ${version}.`));
      return values.some(body => body.includes(`Watchdog ${finding.candidate.reason}.`) && body.includes(`Session ${finding.candidate.sessionId}`) && body.includes(`Retry ${finding.retry}; cancellation ${finding.cancel}.`) && body.includes(`Assessment ${finding.judge.status === 'completed' ? finding.judge.verdict.verdict : finding.judge.status}`) && (finding.judge.status === 'skipped' || body.includes(`Judge Session ${finding.judge.sessionId}.`)));
    });
    await eventually('watchdog event capture', async () => (await proof.capture(body => {
      const event = JSON.parse(body) as { id?: string; type?: string; data?: { id?: string; watchdog?: { finding_id?: string } } };
      return event.id === `evt_${version}` && event.type === 'agent.session.watchdog' && event.data?.id === finding.candidate.sessionId && event.data?.watchdog?.finding_id === version;
    })).length > 0);
    const deliveryId = `wh_${hash(JSON.stringify([proof.owner, endpointId, `evt_${version}`]))}`;
    const delivery = await proof.store.get<WebhookDelivery>(proof.owner, 'webhook_deliveries', deliveryId);
    check(delivery?.value.status === 'delivered' && delivery.value.event.id === `evt_${version}`, 'private delivered status and exact event identity');
  }
}, proofTimeout * 8);
