import { it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import type { SessionState, SessionTurnBinding } from '../../src/core/session-ports.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { StoredEnvironment } from '../../src/core/environment-service.js';
import type { WatchdogCandidate, WatchdogFinding } from '../../src/domain/watchdog.js';
import type { RunSource } from '../../src/domain/contracts.js';
import type { SessionIntegrationInput, SessionIntegrationState } from '../../src/domain/session-integrations.js';
import type { WebhookDelivery, WebhookEndpoint } from '../../src/domain/session-webhooks.js';
import { parseWatchdogVerdict, watchdogIdentity } from '../../src/core/watchdog-planning.js';
import { integrationInputDigest } from '../../src/core/session-integration-planning.js';
import { assistantText, aws, check, eventually, hash, proofTimeout, required, SecurityProof } from '../../testing/aws/super-security-proof.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUPER_AGENT_PROOF === 'true' ? it : it.skip;

live('reports held work, delivers one provider retry, and judges across threshold windows with the consumer paused except for reply delivery', async () => {
  const proof = new SecurityProof();
  let endpointId: string | undefined;
  const originalLambdaEnvironments = new Map<string, Record<string, string>>();
  const expectedLambdaEnvironments = new Map<string, Record<string, string>>();
  let watchdogSchedule: WatchdogSchedule | undefined;
  let succeeded = false;
  try {
    await proof.validate();
    watchdogSchedule = await snapshotWatchdogSchedule(proof);
    await proof.pauseOutbox();
    for (const kind of ['watchdog', 'agents-outbox'] as const) {
      const functionName = required(kind === 'watchdog' ? 'AWS_E2E_WATCHDOG_FUNCTION_NAME' : 'AWS_E2E_AGENTS_OUTBOX_FUNCTION_NAME');
      const configuration = await lambdaConfiguration(proof, functionName);
      const variables = configuration.Environment?.Variables;
      check(variables && configuration.FunctionArn === `arn:aws:lambda:${proof.region}:${proof.account}:function:${functionName}`, `exact ${kind} Lambda configuration`);
      check(configuration.LastUpdateStatus === 'Successful' && configuration.RevisionId, `stable ${kind} Lambda revision before proof override`);
      originalLambdaEnvironments.set(functionName, { ...variables });
      check(variables.TEAMS_REPLY_GATEWAY_URL_SECRET_ARN && variables.TEAMS_REPLY_GATEWAY_URL_SECRET_ARN === variables.TEAMS_WORKFLOW_URL_SECRET_ARN, `${kind} uses the owned capture secret for threaded replies`);
      if (kind === 'watchdog') {
        check(variables.WATCHDOG_LONG_RUNNING_SECONDS === '1800', 'deployed long-running threshold before proof override');
        const override = { ...variables, WATCHDOG_LONG_RUNNING_SECONDS: '60', TEAMS_DELIVERY_MODE: 'threaded-gateway' };
        expectedLambdaEnvironments.set(functionName, override);
        await updateLambdaEnvironment(proof, functionName, override, configuration.RevisionId);
      } else {
        const override = { ...variables, TEAMS_DELIVERY_MODE: 'threaded-gateway' };
        expectedLambdaEnvironments.set(functionName, override);
        await updateLambdaEnvironment(proof, functionName, override, configuration.RevisionId);
      }
      proof.evidence.lambdaOverrides ??= {};
      (proof.evidence.lambdaOverrides as Record<string, unknown>)[kind] = { functionName, originalRevisionId: configuration.RevisionId, originalDeliveryMode: variables.TEAMS_DELIVERY_MODE, proofDeliveryMode: 'threaded-gateway', ...(kind === 'watchdog' ? { originalLongRunningSeconds: variables.WATCHDOG_LONG_RUNNING_SECONDS, proofLongRunningSeconds: '60' } : {}) };
    }
    const endpoint = await proof.client.post<WebhookEndpoint>('/webhooks', { body: {
      name: proof.proofId, url: required('AWS_E2E_WEBHOOK_CAPTURE_URL'), events: ['agent.session.watchdog'],
    } });
    endpointId = endpoint.id;

    const heldSource = providerSource('held');
    const held = await seed('queued', `hold-${proof.proofId}`, heldSource);
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
    const independentTick = await proof.tick();
    check(!independentTick.partial && independentTick.errors === 0, 'complete zero-error watchdog tick with outbox consumer disabled');
    await proof.revisit();
    check((await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', heldId))?.value.reportVersion === 1, 'stable held-work finding version');
    const heldDeliveries = (await proof.records<WebhookDelivery>('webhook_deliveries')).filter(value => value.value.endpointId === endpoint.id && value.value.event.id === `evt_${heldId}_1`);
    check(heldDeliveries.length === 1 && heldDeliveries[0]!.value.status === 'delivered', 'one logical held-work webhook delivery');
    const pending = (await proof.state(held.session.id)).value;
    check(Object.values(pending.receipts).length === 1 && Object.values(pending.receipts).every(value => !value.dispatched), 'injected work remains undispatched');
    await markSeededOutboxWorkSettled(held.session.id);
    proof.evidence.report = { sessionId: held.session.id, findingId: heldId, reportVersion: 1, logicalWebhookDeliveries: heldDeliveries.length, queueConsumer: 'Disabled', trigger: 'scheduled watchdog report before the first manual invocation, followed by a complete zero-error manual tick with the FIFO consumer disabled', seed: 'injected queued Turn under an API-created owned Session' };

    const retrySource = providerSource('retry');
    const retryMarker = `${proof.proofId}-retry-${hash(JSON.stringify([retrySource.conversationId, retrySource.activityId])).slice(0, 12)}`;
    const failed = await seed('failed', retryMarker, retrySource, true);
    const failedTurn = failed.turns[0]!;
    const originalRetryReceipt = (await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', failed.session.id))!.value.inputs[0]!;
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
    check((completedRetry.turn.usage?.total_tokens ?? 0) > 0 && retryText.includes(retryMarker), 'actual persisted model retry output and usage');
    const retryFinding = (await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', retryId))!;
    check(retryFinding.value.retry === 'submitted' && retryFinding.value.judge.status === 'skipped', 'transient retry without judge');
    await reports(retryId, retryFinding.value);
    for (let i = 0; i < 2; i++) await proof.revisit();
    const revisited = (await proof.state(failed.session.id)).value;
    check(revisited.turns.length === 2 && Object.keys(revisited.receipts).filter(value => value.startsWith('watchdog_')).join() === key, 'retry remains unique after repeated deployed ticks');
    check((await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', retryId))?.value.reportVersion === retryFinding.value.reportVersion, 'stable retry report version');
    check(!await proof.store.get(proof.owner, 'sessions', `sess_${retryId}_judge`), 'no transient judge Session');
    proof.evidence.retry = { sessionId: failed.session.id, seedTurnId: failedTurn.turn.id, seed: 'injected server_overloaded', retryTurnId: expectedTurn, receiptKey: key, completedRealModelTurns: 1, tokens: completedRetry.turn.usage!.total_tokens, outputSurface: 'persisted runtime snapshot and actual public Turn' };

    const progress = await seed('in_progress', `judge-${proof.proofId}`, providerSource('judge'));
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
    check(judge.turns.length === 1 && judgeTurn.turn.status === 'completed' && judgeTurn.turn.subagent_id === null && (judgeTurn.turn.usage?.total_tokens ?? 0) > 0, 'exactly one completed root judge Turn and usage');
    check((judgeTurn.savedItems ?? []).every(item => ['message', 'reasoning', 'agent_message'].includes(item.type)), 'zero judge tool calls');
    const verdict = parseWatchdogVerdict(assistantText(judge, judgeTurn.turn.id));
    check(verdict && JSON.stringify(verdict) === JSON.stringify(judged.judge.verdict), 'actual parsed model verdict');
    check(judged.cancel === 'not_requested' && (await proof.state(progress.session.id)).value.turns.every(value => !value.cancelRequested), 'no source cancellation');
    await reports(judgeFindingId!, judged);
    const reportIdsBeforeWindow = await longRunningReportIds(progress.session.id, judgeFindingId!, judged.reportVersion);
    await proof.mappingState('Disabled');
    proof.evidence.judge = { sessionId: progress.session.id, seed: 'injected aged progress', findingId: judgeFindingId, judgeSessionId: judgeId, verdict: verdict.verdict, confidence: verdict.confidence, reportVersion: judged.reportVersion, tokens: judgeTurn.turn.usage!.total_tokens };

    const firstWindow = Math.floor((await proof.store.get<WatchdogFinding>(proof.owner, 'watchdog_findings', judgeFindingId!))!.createdAt / 60);
    await eventually('next long-running threshold window', async () => Math.floor(Date.now() / 1000 / 60) > firstWindow, 70_000);
    const windowTick = await proof.tick();
    check(!windowTick.partial && windowTick.errors === 0, 'zero-error watchdog tick after the threshold window');
    const findingsAfterWindow = (await proof.records<WatchdogFinding>('watchdog_findings')).filter(value => value.value.candidate.sessionId === progress.session.id && value.value.candidate.turnId === progress.turns[0]!.turn.id && value.value.candidate.reason === 'long_running');
    check(findingsAfterWindow.length === 1 && findingsAfterWindow[0]!.id === judgeFindingId, 'one canonical long-running incident across threshold windows');
    check(findingsAfterWindow[0]!.value.judge.status === 'completed' && findingsAfterWindow[0]!.value.judge.sessionId === judgeId && findingsAfterWindow[0]!.value.reportVersion === judged.reportVersion && findingsAfterWindow[0]!.value.reportedVersion === judged.reportedVersion, 'stable judge and report identity across threshold windows');
    check(JSON.stringify(await longRunningReportIds(progress.session.id, judgeFindingId!, judged.reportVersion)) === JSON.stringify(reportIdsBeforeWindow), 'unchanged delivered webhook identities across threshold windows');
    const observedWindow = Math.floor(Date.now() / 1000 / 60);
    check(observedWindow > firstWindow, 'tick occurred after the long-running threshold window boundary');
    proof.evidence.windowStability = { thresholdSeconds: 60, firstWindow, observedWindow, findingId: judgeFindingId, judgeSessionId: judgeId, reportVersion: judged.reportVersion, publishedEventIds: reportIdsBeforeWindow };

    await eventually('complete deployed watchdog scan without errors', async () => {
      const scan = await proof.tick();
      if (scan.partial || scan.errors !== 0) return false;
      proof.evidence.completeScan = scan;
      return true;
    });

    await setOutboxMapping(proof, 'Enabled');
    await eventually('provider retry answer and durable receipt', async () => {
      const state = (await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', failed.session.id))?.value;
      const retried = state?.inputs.filter(value => value.turnId === expectedTurn) ?? [];
      const captures = await proof.capture(body => isRetryAnswerCapture(body, { retryTurnId: expectedTurn, source: retrySource, marker: retryMarker }));
      if (retried.length === 0 || retried[0]?.deliveryProcessed !== true || captures.length === 0) return false;
      check(retried.length === 1 && retried[0]?.source.kind === 'teams', 'one durable retry receipt processed for original source');
      return true;
    }, 180_000);
    await setOutboxMapping(proof, 'Disabled');
    const deliveryReplay = await proof.replaySessionDelivery(failed.session.id, expectedTurn);
    const replayed = await drainRetryAnswerCaptures(proof, expectedTurn, retrySource, retryMarker, 12_000);
    check(replayed.length === 0 && proof.captures.filter(body => isRetryAnswerCapture(body, { retryTurnId: expectedTurn, source: retrySource, marker: retryMarker })).length === 1, 'one captured provider reply with bounded absence after two acknowledged delivery replays');
    await completeCollectorSweep(proof);
    const finalRetryTurns = await proof.client.beta.agents.sessions.turns.list(failed.session.id, { limit: 100 });
    check(finalRetryTurns.data.length === 2 && finalRetryTurns.data.every(value => value.subagent_id === null) && finalRetryTurns.data.some(value => value.id === failedTurn.turn.id && value.status === 'failed') && finalRetryTurns.data.some(value => value.id === expectedTurn && value.status === 'completed'), 'same seed and completed retry root Turns after queue processing');
    const finalRetryState = (await proof.state(failed.session.id)).value;
    check(finalRetryState.turns.length === 2 && Object.keys(finalRetryState.receipts).filter(value => value.startsWith('watchdog_')).join() === key && JSON.stringify(finalRetryState.receipts[key]) === JSON.stringify(receipt), 'same unique dispatched retry command after queue processing');
    const finalRetryRuntime = (await proof.store.get<StoredSessionRuntime>(proof.owner, 'session_runtime', failed.session.id))!.value;
    const finalCompletedRetry = finalRetryRuntime.snapshot?.turns.find(value => value.turn.id === expectedTurn);
    check(finalCompletedRetry?.turn.status === 'completed' && (finalCompletedRetry.turn.usage?.total_tokens ?? 0) > 0 && JSON.stringify(finalCompletedRetry.items) === JSON.stringify(completedRetry.items), 'completed retry output persists after queue processing');
    const finalFindings = (await proof.records<WatchdogFinding>('watchdog_findings')).filter(value => value.value.candidate.sessionId === progress.session.id && value.value.candidate.turnId === progress.turns[0]!.turn.id && value.value.candidate.reason === 'long_running');
    check(finalFindings.length === 1 && finalFindings[0]!.id === judgeFindingId && JSON.stringify(finalFindings[0]!.value) === JSON.stringify(judged), 'same canonical finding and judge after queue processing');
    const finalJudge = (await proof.state(judgeId)).value;
    check(finalJudge.turns.length === 1 && finalJudge.turns[0]!.turn.id === judgeTurn.turn.id && finalJudge.turns[0]!.turn.subagent_id === null && finalJudge.turns[0]!.turn.status === 'completed', 'same single completed root judge Turn after queue processing');
    check(JSON.stringify(await longRunningReportIds(progress.session.id, judgeFindingId!, judged.reportVersion)) === JSON.stringify(reportIdsBeforeWindow), 'same published report identities after queue processing');
    const retryIntegration = (await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', failed.session.id))!.value;
    const retryReceipt = retryIntegration.inputs.filter(value => value.turnId === expectedTurn);
    check(retryReceipt.length === 1 && retryReceipt[0]!.id !== originalRetryReceipt.id && retryReceipt[0]!.deliveryProcessed, 'one processed retry integration receipt');
    for (const field of ['source', 'actor', 'credentialSubject'] as const) check(JSON.stringify(retryReceipt[0]![field]) === JSON.stringify(originalRetryReceipt[field]), `retry preserves exact original ${field}`);
    proof.evidence.providerRetryDelivery = { originalSource: retrySource.kind, conversationId: retrySource.conversationId, replyToActivityId: retrySource.activityId, retryTurnId: expectedTurn, durableDeliveryProcessed: retryReceipt[0]!.deliveryProcessed, capturedReplies: 1, capturePath: 'owned threaded gateway SQS capture', initialDelivery: 'deployed FIFO consumer', deliveryReplay, replayWindowSeconds: 12, duplicateRepliesDuringReplayWindow: replayed.length };
    succeeded = true;
  } finally {
    const failures: string[] = [];
    let handlersDrained = false;
    if (proof.evidence.mapping) {
      try { await setOutboxMapping(proof, 'Disabled'); } catch { failures.push('pause outbox mapping before cleanup'); }
    }
    if (watchdogSchedule) {
      try {
        await pauseWatchdogSchedule(proof, watchdogSchedule);
        const outbox = await proof.function('agents-outbox');
        const watchdog = await proof.function('watchdog');
        const drainSeconds = Math.max(outbox.Configuration.Timeout, watchdog.Configuration.Timeout) + 5;
        check(Number.isSafeInteger(drainSeconds) && drainSeconds > 5 && drainSeconds <= 905, 'bounded Lambda handler drain');
        await delay(drainSeconds * 1000);
        await proof.mappingState('Disabled');
        check(await watchdogConcurrency(proof) === 0 && (await ownedWatchdogRule(proof)).State === 'DISABLED', 'watchdog remains fenced after handler drain');
        handlersDrained = failures.length === 0;
        proof.evidence.cleanupDrain = { seconds: drainSeconds, watchdogConcurrency: 0, schedule: 'DISABLED', outbox: 'Disabled' };
      } catch { failures.push('disable scheduled watchdog and drain handlers before cleanup'); }
    }
    for (const [functionName, variables] of originalLambdaEnvironments) {
      try {
        const restoredRevisionId = await restoreLambdaEnvironment(proof, functionName, variables, expectedLambdaEnvironments.get(functionName));
        const overrides = proof.evidence.lambdaOverrides as Record<string, Record<string, unknown>> | undefined;
        const evidence = Object.values(overrides ?? {}).find(value => value.functionName === functionName);
        if (evidence) evidence.restoredRevisionId = restoredRevisionId;
      } catch { failures.push(`restore ${functionName} environment`); }
    }
    try {
      check(handlersDrained || proof.sessions.size === 0, 'handlers drained before deleting proof Sessions');
      await proof.deleteSessions();
      if (proof.sessions.size) {
        check(!(await proof.records<WatchdogFinding>('watchdog_findings')).some(value => proof.sessions.has(value.value.candidate.sessionId ?? '')), 'no owned findings after quiescent cleanup');
        check(!(await proof.records<SessionState>('sessions')).some(value => proof.sessions.has(value.id) || value.value.session.metadata?.proof_id === proof.proofId), 'no owned Sessions after quiescent cleanup');
      }
    } catch { failures.push('owned Session and finding cleanup'); }
    try { if (endpointId) await proof.client.delete(`/webhooks/${endpointId}`); } catch { failures.push('owned webhook cleanup'); }
    try { if (watchdogSchedule) await restoreWatchdogSchedule(proof, watchdogSchedule); } catch { failures.push('watchdog schedule and concurrency restoration'); }
    try { await proof.restoreOutbox(); } catch { failures.push('outbox mapping restoration'); }
    proof.destroy();
    check(failures.length === 0, failures.join('; '));
    if (succeeded) console.log(JSON.stringify({ proof: 'live-watchdog', status: 'PASS', ...proof.evidence }));
  }

  function providerSource(tag: string): Extract<RunSource, { kind: 'teams' }> {
    return {
      kind: 'teams', tenantId: `${proof.proofId}-tenant`, teamId: `${proof.proofId}-team`, channelId: `${proof.proofId}-${tag}-channel`,
      conversationId: `${proof.proofId}-${tag}-conversation`, activityId: `${proof.proofId}-${tag}-activity`, senderId: `${proof.proofId}-sender`,
    };
  }

  async function attachProviderReceipt(session: SessionState, source: Extract<RunSource, { kind: 'teams' }>, text: string, processed = false): Promise<void> {
    const sessionId = session.session.id;
    check(!await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', sessionId), 'no preexisting integration state on API-created proof Session');
    const senderId = source.senderId!;
    const id = `provider-${proof.proofId}-${source.activityId}`;
    const input: SessionIntegrationInput = {
      admission: 'explicit', id, text, source,
      actor: { kind: 'human', id: senderId, provider: 'teams' }, credentialSubject: { kind: 'actor', id: senderId },
    };
    const value: SessionIntegrationState = {
      target: { agentId: session.session.agent.id, environment: { type: 'openai_hosted' }, destinations: [{ kind: 'teams' }] },
      inputs: [{ ...input, digest: integrationInputDigest(input), turnId: session.turns[0]!.turn.id, ...(processed ? { deliveryProcessed: true } : {}) }],
    };
    await proof.store.put({ ownerId: proof.owner, id: sessionId, collection: 'session_integrations', createdAt: Math.floor(Date.now() / 1000), revision: 1, value }, 0);
    const saved = await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', sessionId);
    check(saved?.value.inputs.length === 1 && saved.value.inputs[0]?.turnId === session.turns[0]?.turn.id && saved.value.inputs[0]?.source.kind === 'teams'
      && saved.value.target.agentId === session.session.agent.id && saved.value.target.environment.type === session.session.environment.type && saved.value.target.destinations?.length === 1 && saved.value.target.destinations[0]?.kind === 'teams',
    'synthetic provider receipt targets the injected Turn with the Session agent, environment, and fixed Teams destination');
  }

  async function markSeededOutboxWorkSettled(sessionId: string): Promise<void> {
    const current = await proof.state(sessionId);
    const receipt = current.value.receipts[proof.proofId];
    check(receipt && !receipt.dispatched, 'held Session has only its injected undispatched receipt');
    const value = { ...current.value, receipts: { ...current.value.receipts, [proof.proofId]: { ...receipt, dispatched: true } } };
    await new SessionEventStore(proof.store).put({ ...current, revision: current.revision + 1, value }, current.revision);
    check((await proof.state(sessionId)).value.receipts[proof.proofId]?.dispatched, 'settle owned held receipt before resuming its queue consumer');
  }

  async function seed(status: 'queued' | 'failed' | 'in_progress', finalAnswer?: string, source?: Extract<RunSource, { kind: 'teams' }>, processed = false): Promise<SessionState> {
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
    const input: SessionTurnBinding['input'] = [{ id: `msg_${hash(turnId).slice(0, 32)}`, role: 'user', content: [{ type: 'input_text', text: `Reply exactly ${finalAnswer ?? `${proof.proofId}-retry`}. Do not use tools.` }] }];
    const binding: SessionTurnBinding = {
      turn: { id: turnId, object: 'agent.session.turn', session_id: session.id, agent_id: session.agent.id, subagent_id: null, status, created_at: at, started_at: status === 'queued' ? null : at, completed_at: status === 'failed' ? at : null, error: status === 'failed' ? { code: 'server_overloaded', message: 'Injected disposable live proof failure' } : null, usage: null },
      input, savedItems: status === 'in_progress' ? [{ id: `msg_${hash(`${turnId}:progress`).slice(0, 32)}`, type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', turn_id: turnId, content: [{ type: 'output_text', text: 'I am comparing two harmless calculations and checking the intermediate result.' }] }] : [], savedArtifacts: [],
    };
    const next: SessionState = { ...current.value, turns: [binding], receipts: status === 'queued' ? { [proof.proofId]: { digest: hash(turnId), commands: [{ type: 'start', turnId, input }], dispatched: false } } : {} };
    if (source) await attachProviderReceipt(next, source, finalAnswer ?? `${proof.proofId}-${status}`, processed);
    await new SessionEventStore(proof.store).put({ ...current, revision: current.revision + 1, value: next }, current.revision);
    const saved = await proof.state(session.id);
    const observation = await proof.store.get<SessionStreamSnapshot>(proof.owner, 'session_observations', session.id);
    check(saved.createdAt === current.createdAt && saved.value.turns[0]?.turn.status === status && observation?.value.turns[0]?.status === status, 'CAS seed and committed observation');
    check(JSON.stringify(saved.value.session) === JSON.stringify(current.value.session) && JSON.stringify(saved.value.runtime) === JSON.stringify(current.value.runtime) && saved.value.placement === current.value.placement, 'seed preserves API-created Session and execution envelope');
    return saved.value;
  }
  async function reports(id: string, finding: WatchdogFinding): Promise<void> {
    const version = `${id}_${finding.reportVersion}`;
    const integration = await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', finding.candidate.sessionId!);
    const source = integration?.value.inputs.at(-1)?.source;
    check(source?.kind === 'teams', 'finding report uses the seeded provider thread');
    await eventually('Teams finding capture', async () => {
      return (await proof.capture(body => isWatchdogReportCapture(body, { version, source, finding }))).length > 0;
    });
    await eventually('watchdog event capture', async () => (await proof.capture(body => {
      const event = JSON.parse(body) as { id?: string; type?: string; data?: { id?: string; watchdog?: { finding_id?: string } } };
      return event.id === `evt_${version}` && event.type === 'agent.session.watchdog' && event.data?.id === finding.candidate.sessionId && event.data?.watchdog?.finding_id === version;
    })).length > 0);
    const deliveryId = `wh_${hash(JSON.stringify([proof.owner, endpointId, `evt_${version}`]))}`;
    const delivery = await proof.store.get<WebhookDelivery>(proof.owner, 'webhook_deliveries', deliveryId);
    check(delivery?.value.status === 'delivered' && delivery.value.event.id === `evt_${version}`, 'private delivered status and exact event identity');
  }

  async function longRunningReportIds(sessionId: string, findingId: string, version: number): Promise<string[]> {
    const deliveries = (await proof.records<WebhookDelivery>('webhook_deliveries')).filter(value => value.value.endpointId === endpointId && value.value.event.type === 'agent.session.watchdog' && value.value.event.data.id === sessionId && value.value.event.data.watchdog?.reason === 'long_running');
    const ids = deliveries.map(value => value.value.event.id).sort();
    check(deliveries.every(value => value.value.status === 'delivered') && new Set(ids).size === ids.length, 'unique delivered logical long-running report identities');
    check(ids.filter(id => id === `evt_${findingId}_${version}`).length === 1, 'latest judge report delivered exactly once');
    return ids;
  }
}, proofTimeout * 8);

interface LambdaConfiguration {
  FunctionArn: string;
  RevisionId?: string;
  State?: string;
  LastUpdateStatus?: string;
  Environment?: { Variables?: Record<string, string> };
}

interface WatchdogRule {
  Name: string;
  Arn: string;
  ScheduleExpression: string;
  State: 'ENABLED' | 'DISABLED';
}

interface WatchdogSchedule {
  rule: WatchdogRule;
  reservedConcurrentExecutions: number;
}

async function ownedWatchdogRule(proof: SecurityProof): Promise<WatchdogRule> {
  const name = required('AWS_E2E_WATCHDOG_RULE_NAME');
  check(name === `${proof.prefix}-watchdog`, 'exact owned watchdog rule name');
  const rule = await aws<WatchdogRule>(proof.region, ['events', 'describe-rule', '--name', name]);
  check(rule.Name === name && rule.Arn === `arn:aws:events:${proof.region}:${proof.account}:rule/${name}` && rule.ScheduleExpression === 'rate(1 minute)' && ['ENABLED', 'DISABLED'].includes(rule.State), 'exact owned watchdog rule');
  const targets = await aws<{ Targets: Array<{ Id: string; Arn: string }> }>(proof.region, ['events', 'list-targets-by-rule', '--rule', name]);
  check(targets.Targets.length === 1 && targets.Targets[0]!.Id === 'watchdog' && targets.Targets[0]!.Arn === `arn:aws:lambda:${proof.region}:${proof.account}:function:${proof.prefix}-watchdog`, 'exact owned watchdog schedule target');
  return rule;
}

async function watchdogConcurrency(proof: SecurityProof): Promise<number | undefined> {
  const name = required('AWS_E2E_WATCHDOG_FUNCTION_NAME');
  check(name === `${proof.prefix}-watchdog`, 'exact owned watchdog concurrency target');
  return (await aws<{ ReservedConcurrentExecutions?: number }>(proof.region, ['lambda', 'get-function-concurrency', '--function-name', name])).ReservedConcurrentExecutions;
}

async function snapshotWatchdogSchedule(proof: SecurityProof): Promise<WatchdogSchedule> {
  const rule = await ownedWatchdogRule(proof);
  const reservedConcurrentExecutions = await watchdogConcurrency(proof);
  check(rule.State === 'ENABLED' && reservedConcurrentExecutions === 1, 'enabled serialized watchdog before proof');
  const snapshot = { rule, reservedConcurrentExecutions };
  proof.evidence.watchdogSchedule = snapshot;
  return snapshot;
}

async function pauseWatchdogSchedule(proof: SecurityProof, snapshot: WatchdogSchedule): Promise<void> {
  check((await ownedWatchdogRule(proof)).State === snapshot.rule.State, 'watchdog schedule unchanged before cleanup pause');
  check(await watchdogConcurrency(proof) === snapshot.reservedConcurrentExecutions, 'watchdog concurrency unchanged before cleanup pause');
  await setWatchdogRuleState(proof, snapshot.rule.Name, 'DISABLED');
  await eventually('watchdog schedule disabled', async () => (await ownedWatchdogRule(proof)).State === 'DISABLED', 120_000);
  await aws(proof.region, ['lambda', 'put-function-concurrency', '--function-name', `${proof.prefix}-watchdog`, '--reserved-concurrent-executions', '0']);
  await eventually('watchdog invocation fence', async () => await watchdogConcurrency(proof) === 0, 120_000);
}

async function restoreWatchdogSchedule(proof: SecurityProof, snapshot: WatchdogSchedule): Promise<void> {
  try {
    const concurrency = await watchdogConcurrency(proof);
    check(concurrency === 0 || concurrency === snapshot.reservedConcurrentExecutions, 'only proof-owned watchdog concurrency changes remain');
    if (concurrency === 0) await aws(proof.region, ['lambda', 'put-function-concurrency', '--function-name', `${proof.prefix}-watchdog`, '--reserved-concurrent-executions', String(snapshot.reservedConcurrentExecutions)]);
    await eventually('watchdog concurrency restored', async () => await watchdogConcurrency(proof) === snapshot.reservedConcurrentExecutions, 120_000);
    proof.evidence.watchdogConcurrencyRestored = snapshot.reservedConcurrentExecutions;
  } finally {
    const rule = await ownedWatchdogRule(proof);
    if (rule.State !== snapshot.rule.State) await setWatchdogRuleState(proof, rule.Name, snapshot.rule.State);
    await eventually('watchdog schedule restored', async () => (await ownedWatchdogRule(proof)).State === snapshot.rule.State, 120_000);
    proof.evidence.watchdogScheduleRestored = snapshot.rule.State;
  }
}

async function setWatchdogRuleState(proof: SecurityProof, name: string, state: WatchdogRule['State']): Promise<void> {
  check(name === `${proof.prefix}-watchdog`, 'exact watchdog schedule mutation target');
  try {
    await promisify(execFile)('aws', ['events', state === 'ENABLED' ? 'enable-rule' : 'disable-rule', '--name', name, '--region', proof.region, '--output', 'json', '--no-cli-pager'], { timeout: 120_000 });
  } catch { throw new Error(`Live security AWS operation failed: watchdog schedule ${state}`); }
}

async function completeCollectorSweep(proof: SecurityProof): Promise<void> {
  const watchdog = await proof.function('watchdog');
  const owner = watchdog.Configuration.Environment?.Variables?.WATCHDOG_OWNER_ID;
  check(owner, 'configured watchdog scan owner');
  for (let cycle = 0; cycle < 2; cycle++) await eventually('complete deployed collector sweep after queue processing', async () => {
    const tick = await proof.tick();
    check(tick.errors === 0, 'zero-error collector sweep after queue processing');
    const cursor = await proof.store.get<{ agents?: unknown; runs?: unknown; candidateOffset?: number }>(owner, 'watchdog_scan', 'cursor');
    return !tick.partial && Boolean(cursor && !cursor.value.agents && !cursor.value.runs && !cursor.value.candidateOffset);
  });
}

interface TeamsGatewayCapture {
  conversationId?: string;
  replyToActivityId?: string;
  activity?: { text?: string };
  source?: { tenantId?: string; conversationId?: string; activityId?: string };
  execution?: { id?: string; status?: string; type?: string };
}

function parseTeamsGatewayCapture(body: string): TeamsGatewayCapture | undefined {
  try { return JSON.parse(body) as TeamsGatewayCapture; }
  catch { return undefined; }
}

async function lambdaConfiguration(proof: SecurityProof, functionName: string): Promise<LambdaConfiguration> {
  return aws<LambdaConfiguration>(proof.region, ['lambda', 'get-function-configuration', '--function-name', functionName]);
}

async function updateLambdaEnvironment(proof: SecurityProof, functionName: string, variables: Record<string, string>, revisionId: string): Promise<void> {
  const current = await lambdaConfiguration(proof, functionName);
  const expectedArn = `arn:aws:lambda:${proof.region}:${proof.account}:function:${functionName}`;
  check(current.FunctionArn === expectedArn && current.RevisionId === revisionId, `exact ${functionName} update revision`);
  const directory = await mkdtemp(join(tmpdir(), 'rat-watchdog-env-'));
  try {
    const path = join(directory, 'environment.json');
    await writeFile(path, JSON.stringify({ Variables: variables }));
    const updated = await aws<LambdaConfiguration>(proof.region, ['lambda', 'update-function-configuration', '--function-name', functionName, '--revision-id', current.RevisionId, '--environment', `file://${path}`]);
    check(updated.FunctionArn === expectedArn, `exact ${functionName} environment target`);
    await eventually(`${functionName} environment update`, async () => {
      const saved = await lambdaConfiguration(proof, functionName);
      return saved.LastUpdateStatus === 'Successful' && sameEnvironment(saved.Environment?.Variables ?? {}, variables);
    }, 120_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function restoreLambdaEnvironment(proof: SecurityProof, functionName: string, original: Record<string, string>, expected?: Record<string, string>): Promise<string | undefined> {
  if (!expected) return undefined;
  const current = await eventuallyValue(`${functionName} configuration ready for restore`, async () => {
    const configuration = await lambdaConfiguration(proof, functionName);
    return configuration.State === 'Active' && configuration.LastUpdateStatus !== 'InProgress' ? configuration : undefined;
  }, 120_000);
  check(current.RevisionId, `stable ${functionName} revision before restore`);
  const currentVariables = current.Environment?.Variables ?? {};
  if (sameEnvironment(currentVariables, original)) return current.RevisionId;
  check(sameEnvironment(currentVariables, expected), `only proof-owned ${functionName} environment changes remain`);
  await updateLambdaEnvironment(proof, functionName, original, current.RevisionId);
  const restored = await lambdaConfiguration(proof, functionName);
  check(restored.LastUpdateStatus === 'Successful' && sameEnvironment(restored.Environment?.Variables ?? {}, original), `exact ${functionName} environment restored`);
  return restored.RevisionId;
}

function sameEnvironment(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

async function setOutboxMapping(proof: SecurityProof, state: 'Enabled' | 'Disabled'): Promise<void> {
  const mapping = proof.evidence.mapping as { uuid?: string } | undefined;
  check(mapping?.uuid, 'owned outbox mapping snapshot');
  await aws(proof.region, ['lambda', 'update-event-source-mapping', '--uuid', mapping.uuid, state === 'Enabled' ? '--enabled' : '--no-enabled']);
  await proof.mappingState(state);
}

function isRetryAnswerCapture(body: string, expected: { retryTurnId: string; source: Extract<RunSource, { kind: 'teams' }>; marker: string }): boolean {
  const capture = parseTeamsGatewayCapture(body);
  if (!capture) return false;
  return capture.execution?.id === expected.retryTurnId && capture.execution.status === 'completed' && capture.execution.type === 'turn'
    && capture.conversationId === expected.source.conversationId && capture.replyToActivityId === expected.source.activityId
    && capture.source?.tenantId === expected.source.tenantId && capture.activity?.text?.split('\n\n---\n', 1)[0] === expected.marker;
}

function isRetryExecutionCapture(body: string, retryTurnId: string): boolean {
  return parseTeamsGatewayCapture(body)?.execution?.id === retryTurnId;
}

function isWatchdogReportCapture(body: string, expected: { version: string; source: Extract<RunSource, { kind: 'teams' }>; finding: WatchdogFinding }): boolean {
  const capture = parseTeamsGatewayCapture(body);
  if (!capture) return false;
  const text = capture.activity?.text ?? '';
  const finding = expected.finding;
  const assessment = finding.judge.status === 'completed' ? finding.judge.verdict.verdict : finding.judge.status;
  return capture.execution?.id === expected.version && capture.execution.status === 'completed' && capture.execution.type === 'turn'
    && capture.conversationId === expected.source.conversationId && capture.replyToActivityId === expected.source.activityId
    && capture.source?.tenantId === expected.source.tenantId && text.includes(`Watchdog ${finding.candidate.reason}.`)
    && text.includes(`Session ${finding.candidate.sessionId}; Turn ${finding.candidate.turnId ?? 'none'}.`)
    && text.includes(`Retry ${finding.retry}; cancellation ${finding.cancel}.`) && text.includes(`Assessment ${assessment}`)
    && text.includes(`Finding ${expected.version}.`) && (finding.judge.status === 'skipped' || text.includes(`Judge Session ${finding.judge.sessionId}.`));
}

async function drainRetryAnswerCaptures(proof: SecurityProof, retryTurnId: string, source: Extract<RunSource, { kind: 'teams' }>, marker: string, durationMs: number): Promise<string[]> {
  const deadline = Date.now() + durationMs;
  const duplicates: string[] = [];
  while (Date.now() < deadline) {
    const page = await proof.sqs.send(new ReceiveMessageCommand({ QueueUrl: proof.queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 15 }));
    for (const message of page.Messages ?? []) {
      check(message.ReceiptHandle, 'provider answer capture receipt');
      if (isRetryExecutionCapture(message.Body ?? '', retryTurnId)) {
        check(isRetryAnswerCapture(message.Body ?? '', { retryTurnId, source, marker }), 'replayed retry answer retains its original source and thread');
        duplicates.push(message.Body!);
        await proof.sqs.send(new DeleteMessageCommand({ QueueUrl: proof.queue, ReceiptHandle: message.ReceiptHandle }));
      } else await proof.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: proof.queue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    await delay(250);
  }
  return duplicates;
}

async function eventuallyValue<T>(label: string, predicate: () => Promise<T | undefined>, timeout = proofTimeout): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error(`Live security proof deadline: ${label}`);
}
