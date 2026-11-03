import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import type { SourceCapabilityBinding } from '../../src/domain/capabilities.js';
import type { ArtifactReference, RunRecord, RunRequest } from '../../src/domain/contracts.js';
import type { EventCandidate, EventCandidateThread } from '../../src/domain/event-candidates.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import type { IntegrationOccurrence, SessionIntegrationState, ThreadSubscription } from '../../src/domain/session-integrations.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUPER_AGENT_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 600_000);
type Evidence = { check: string; passed: boolean; ids?: Record<string, string | number> };
type IngressReply = { accepted?: boolean; reason?: string; ignored?: boolean; sessionId?: string; candidateId?: string };
type Fixture = { provider: 'github' | 'gitlab' | 'slack'; id: string; event: string; body: string; occurrenceId: string };
type Completed = { sessionId: string; turn: Turn; items: AgentSessionItem[]; integration: SessionIntegrationState };
type Mapping = { UUID: string; State: string; FunctionArn: string; EventSourceArn: string };

live.each(['threads', 'filtering', 'reviewed'] as const)('proves %s through deployed routing', async scenario => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Routing proof requires explicit real-model opt-in');
  const region = required('AWS_REGION');
  const deployment = `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`;
  const account = required('AWS_E2E_CALLER_ACCOUNT');
  const tableName = required('AGENTS_TABLE_NAME');
  const runsTable = process.env.RUNS_TABLE_NAME ?? `${deployment}-runs`;
  const definitionBucket = required('DEFINITION_BUCKET');
  const artifactBucket = required('ARTIFACT_BUCKET');
  const queueUrl = required('DELIVERY_CAPTURE_QUEUE_URL');
  const functionName = required('AWS_E2E_AGENTS_OUTBOX_FUNCTION_NAME');
  const marker = `routing-${randomUUID()}`;
  const evidence: Evidence[] = [];
  const createdSessions = new Set<string>();
  const createdAgents = new Set<string>();
  const bindings: SourceCapabilityBinding[] = [];
  const captures = new Map<string, Map<string, string>>();
  const ownedTurns = new Set<string>();
  const observedArtifacts = new Set<string>();
  const proofBase = process.env.AWS_E2E_SUPER_AGENT_PROOF_ARTIFACT ?? `/tmp/${deployment}-${marker}.json`;
  const proofPath = `${proofBase.replace(/\.json$/, '')}-${scenario}.json`;
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
  const control = createAgentsClient({ baseURL: new URL('/v1', required('RAT_THINGS_API_URL')).href, region }).withOptions({ maxRetries: 0 });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const sqs = new SQSClient({ region });
  const objects = new S3ArtifactStore(s3, definitionBucket);
  const store = new DynamoAgentsStore(db, tableName, { getJson: readEncrypted, putJson: async () => { throw new ProofFailure('Private proof storage is read-only'); } });
  const githubSecret = required('GITHUB_WEBHOOK_SIGNING_SECRET');
  const slackSecret = (await readFile(required('AWS_E2E_SLACK_SIGNING_SECRET_FILE'), 'utf8')).trim();
  const githubUrl = required('GITHUB_WEBHOOK_URL');
  const slackUrl = required('SLACK_WEBHOOK_URL');
  const repository = required('AWS_E2E_GITHUB_REPOSITORY');
  const repositoryUrl = required('AWS_E2E_GITHUB_REPOSITORY_URL');
  const headB = required('AWS_E2E_GITHUB_SHA');
  const issue = 1_000_000 + Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16);
  const team = `T${randomUUID().replaceAll('-', '').toUpperCase()}`;
  let ownerId = '';
  let proofFailed = false;
  let sequence = 0;
  let phase = 'setup';
  let quietDelivery: { quietTurnId: string; explicitTurnId: string } | undefined;
  try {
    check('disposable_resource_names', /^rat-things-[a-z0-9-]+$/.test(deployment)
      && tableName === `${deployment}-agents` && runsTable === `${deployment}-runs`
      && functionName === `${deployment}-agents-outbox` && /^\d{12}$/.test(account)
      && [definitionBucket, artifactBucket].every(value => value.startsWith(`${deployment}-`)));
    const queue = new URL(queueUrl);
    check('disposable_capture_url', queue.protocol === 'https:' && queue.hostname === `sqs.${region}.amazonaws.com`
      && queue.pathname === `/${account}/${deployment}-delivery-capture`);
    const [table, capture] = await Promise.all([
      db.send(new DescribeTableCommand({ TableName: tableName })),
      sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })),
    ]);
    check('disposable_resource_accounts', table.Table?.TableArn === `arn:aws:dynamodb:${region}:${account}:table/${tableName}`
      && capture.Attributes?.QueueArn === `arn:aws:sqs:${region}:${account}:${deployment}-delivery-capture`);
    check('public_repository_configuration', /^[\w.-]+\/[\w.-]+$/.test(repository)
      && repositoryUrl === `https://github.com/${repository}.git` && /^[a-f0-9]{40}$/i.test(headB));
    const headA = process.env.AWS_E2E_GITHUB_PREVIOUS_SHA ?? await parentCommit(repository, headB);
    check('distinct_commit_inputs', /^[a-f0-9]{40}$/i.test(headA) && headA !== headB);
    const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [],
      name: marker, instructions: [
        'You are executing a disposable routing proof. Follow this fixed protocol for every input.',
        'For a GitHub pull-request input, execute exactly git rev-parse HEAD in the checked-out repository using command execution. Do not claim a checkout without executing it. Do not modify files or perform a review.',
        `When the input contains RELEASE, call rat_things_thread_release with reason ${marker}, wait for its successful tool output, then finish with the REPLY marker.`,
        'When the input contains QUIET, finish the Turn without any final assistant text. Do not explain, acknowledge, print a marker or substitute punctuation. An empty final response is the required successful result.',
        `For an input without a REPLY marker, finish with only ${reply('candidate_act')}.`,
        'Otherwise finish with only the token after REPLY=. Never create subagents or call external services.',
      ].join('\n') });
    createdAgents.add(agent.id);
    if (scenario === 'threads') {
      const github = await bind({ sourceKind: 'github', selector: { repository, issueNumber: String(issue) }, environment: { type: 'openai_hosted' }, eventPolicy: { mode: 'explicit', actors: { allow: ['github:routing-fixture-user'] } } });
      const invalid = pull('opened', headA, 'authentication');
      for (const provider of ['github', 'slack'] as const) {
        const response = await fetch(provider === 'github' ? githubUrl : slackUrl, { method: 'POST', body: '{', headers: { 'content-type': 'application/json', ...(provider === 'github' ? { 'x-github-event': 'pull_request', 'x-github-delivery': invalid.id, 'x-hub-signature-256': 'sha256=invalid' } : { 'x-slack-signature': 'v0=invalid', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) }) }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
        check(`${provider}_authentication_before_parsing`, response.status === 401);
      }
      check('invalid_signature_has_no_occurrence', !await occurrence(github, `github:${invalid.id}`));
      check('invalid_signature_has_no_session', (await client.beta.agents.sessions.list({ agent_id: agent.id, limit: 100 })).data.length === 0);
      const unbound = await send(slack(`CUNBOUND${sequence++}`, 'app_mention', 'U1', timestamp(), 'unbound'));
      check('signed_unbound_source', unbound.reason === 'source_not_bound' && unbound.accepted === false);

      const opened = pull('opened', headA, 'opened');
      const first = await complete(await acceptedSession(opened), `github:${opened.id}`);
      await delivered(first);
      await checkout(first, headA);
      const initialWorker = await worker(first.sessionId, headA);
      const comment = githubComment('follow_up');
      const follow = await complete(await acceptedSession(comment), `github:${comment.id}`);
      check('github_unmentioned_comment_continues', follow.sessionId === first.sessionId && follow.turn.id !== first.turn.id);
      await delivered(follow);
      await checkout(follow, headA);
      const continuedWorker = await worker(follow.sessionId, headA);
      check('github_continuation_retains_environment_and_execution', initialWorker.environmentId === continuedWorker.environmentId
        && initialWorker.runId === continuedWorker.runId && initialWorker.executionId === continuedWorker.executionId);
      await replay(opened, first);
      await replay(comment, follow);
      const changed = pull('synchronize', headB, 'head_changed');
      const rotated = await complete(await acceptedSession(changed), `github:${changed.id}`);
      await transferred(first, rotated);
      await delivered(rotated);
      await checkout(rotated, headB);
      const rotatedWorker = await worker(rotated.sessionId, headB);
      check('github_new_head_gets_new_environment_and_execution', rotatedWorker.environmentId !== initialWorker.environmentId
        && rotatedWorker.runId !== initialWorker.runId && rotatedWorker.executionId !== initialWorker.executionId);
      await replay(opened, first);
      await replay(comment, follow);
      await replay(changed, rotated);
      const sameHead = pull('synchronize', headB, 'same_head');
      const same = await complete(await acceptedSession(sameHead), `github:${sameHead.id}`);
      check('github_same_head_retains_session', same.sessionId === rotated.sessionId);
      await delivered(same);
      const releaseEvent = githubComment('release', 'RELEASE');
      const release = await complete(await acceptedSession(releaseEvent), `github:${releaseEvent.id}`);
      check('github_release_turn_stays_in_current_session', release.sessionId === rotated.sessionId);
      const releaseCall = release.items.find(item => item.type === 'function_call' && item.name === 'rat_things_thread_release');
      check('release_tool_call_saved', releaseCall?.type === 'function_call' && record(releaseCall.arguments).reason === marker);
      const releaseOutput = release.items.find(item => item.type === 'function_call_output' && item.call_id === (releaseCall?.type === 'function_call' ? releaseCall.call_id : ''));
      check('release_tool_success_saved', releaseOutput?.type === 'function_call_output' && releaseOutput.status === 'completed'
        && typeof releaseOutput.output === 'string' && record(JSON.parse(releaseOutput.output)).released === true);
      const released = await subscription(release);
      check('release_subscription_is_durable', released.subscribers.some(value => value.sessionId === release.sessionId && value.state === 'released'));
      await delivered(release);
      check('unmentioned_github_event_after_release_is_dropped', (await send(githubComment('after_release'))).reason === 'event_policy');
      const reopened = pull('reopened', headB, 'reopened');
      const restarted = await complete(await acceptedSession(reopened), `github:${reopened.id}`);
      await transferred(release, restarted);
      await delivered(restarted);
      await checkout(restarted, headB);
      await replay(changed, rotated);

      const threadChannel = channel();
      await bind({ sourceKind: 'slack', threadScope: 'thread', selector: { teamId: team, channelId: threadChannel }, environment: { type: 'none' }, eventPolicy: { mode: 'explicit' } });
      const root = timestamp();
      const mention = slack(threadChannel, 'app_mention', 'U1', root, 'thread_start');
      const slackFirst = await complete(await acceptedSession(mention), mention.occurrenceId);
      await delivered(slackFirst);
      const secondSender = slack(threadChannel, 'message', 'U2', root, 'thread_other_sender');
      const shared = await complete(await acceptedSession(secondSender), secondSender.occurrenceId);
      check('slack_thread_scope_shares_senders', shared.sessionId === slackFirst.sessionId && shared.turn.id !== slackFirst.turn.id);
      await delivered(shared);
      const sub = await subscription(shared);
      const listed = await control.get<{ data: Array<ThreadSubscription & { id: string }> }>('/integrations/thread-subscriptions', { query: { limit: 100 } });
      check('operator_can_list_subscription', listed.data.some(value => value.id === sub.id));
      const operatorRelease = await control.post<{ released: boolean; sessionId: string }>(`/integrations/thread-subscriptions/${sub.id}/release`, { body: { reason: marker, epoch: sub.epoch } });
      check('operator_release_current_epoch', operatorRelease.released && operatorRelease.sessionId === shared.sessionId);
      check('unmentioned_slack_event_after_release_is_dropped', (await send(slack(threadChannel, 'message', 'U2', root, 'released_follow_up'))).reason === 'event_policy');
      const resumedEvent = slack(threadChannel, 'app_mention', 'U2', root, 'thread_resumed');
      const resumed = await complete(await acceptedSession(resumedEvent), resumedEvent.occurrenceId);
      await transferred(shared, resumed);
      await delivered(resumed);
      let staleStatus: number | undefined;
      try { await control.post(`/integrations/thread-subscriptions/${sub.id}/release`, { body: { reason: marker, epoch: sub.epoch } }); }
      catch (error) { staleStatus = httpStatus(error); }
      check('operator_stale_epoch_is_rejected', staleStatus === 409);
      await replay(mention, slackFirst);

      const senderChannel = channel();
      await bind({ sourceKind: 'slack', threadScope: 'sender', selector: { teamId: team, channelId: senderChannel }, environment: { type: 'none' }, eventPolicy: { mode: 'explicit' } });
      const senderRoot = timestamp();
      const senderEvent = slack(senderChannel, 'app_mention', 'U1', senderRoot, 'sender_start');
      const senderFirst = await complete(await acceptedSession(senderEvent), senderEvent.occurrenceId);
      await delivered(senderFirst);
      check('slack_sender_scope_rejects_other_unmentioned_sender', (await send(slack(senderChannel, 'message', 'U2', senderRoot, 'other_sender_drop'))).reason === 'event_policy');
      const otherEvent = slack(senderChannel, 'app_mention', 'U2', senderRoot, 'other_sender_explicit');
      const other = await complete(await acceptedSession(otherEvent), otherEvent.occurrenceId);
      check('slack_sender_scope_isolates_explicit_sender', other.sessionId !== senderFirst.sessionId);
      await delivered(other);
      const senderFollowEvent = slack(senderChannel, 'message', 'U1', senderRoot, 'sender_follow_up');
      const senderFollow = await complete(await acceptedSession(senderFollowEvent), senderFollowEvent.occurrenceId);
      check('slack_sender_scope_retains_original_sender', senderFollow.sessionId === senderFirst.sessionId);
      await delivered(senderFollow);
    }

    if (scenario === 'reviewed') {
      const github = await bind({ sourceKind: 'github', selector: { repository, issueNumber: String(issue) }, environment: { type: 'openai_hosted' }, eventPolicy: { mode: 'explicit' } });
      const githubBeforeSubscription = githubComment('github_unsubscribed_triggered', '@rat-things');
      const githubBeforeReply = await send(githubBeforeSubscription);
      check('github_triggered_comment_without_allowlist_is_denied', githubBeforeReply.accepted === false && githubBeforeReply.reason === 'event_policy');
      check('github_unsubscribed_comment_has_no_occurrence', !await occurrence(github, githubBeforeSubscription.occurrenceId));

      const pullRequest = pull('opened', headA, 'github_bot_lifecycle', { login: 'routing-review-bot[bot]', type: 'Bot' });
      const first = await complete(await acceptedSession(pullRequest), pullRequest.occurrenceId);
      await delivered(first);
      await checkout(first, headA);
      const githubLifecycleInput = first.integration.inputs.find(value => value.id === pullRequest.occurrenceId);
      check('github_bot_pull_request_has_exact_system_actor', githubLifecycleInput?.actor.id === 'github:routing-review-bot[bot]' && githubLifecycleInput.actor.kind === 'system',
        { sessionId: first.sessionId, turnId: first.turn.id });
      const subscriptionBefore = await subscription(first);
      const githubSubscribedComment = githubComment('github_subscribed_untriggered');
      const githubSubscribedReply = await send(githubSubscribedComment);
      check('github_subscribed_comment_without_allowlist_is_denied', githubSubscribedReply.accepted === false && githubSubscribedReply.reason === 'event_policy');
      check('github_subscribed_comment_has_no_occurrence', !await occurrence(github, githubSubscribedComment.occurrenceId));

      const githubPolicy = { mode: 'explicit' as const, actors: { allow: ['github:routing-fixture-user', 'github:routing-review-bot[bot]'] } };
      const githubUpdated = await control.put<SourceCapabilityBinding>(`/integrations/source-bindings/${github.bindingId}/event-policy`, { body: { version: '1', eventPolicy: githubPolicy } });
      check('github_owner_put_sets_exact_actor_policy', githubUpdated.ownerId === ownerId && isDeepStrictEqual(githubUpdated.eventPolicy, githubPolicy));
      check('github_policy_update_preserves_binding_and_target', isDeepStrictEqual(bindingTarget(github), bindingTarget(githubUpdated)));
      const githubSubscriptionAfter = await subscription(first);
      check('github_policy_update_preserves_subscription', isDeepStrictEqual(subscriptionBefore, githubSubscriptionAfter));
      const githubListed = await control.get<{ sourceBindings: SourceCapabilityBinding[] }>('/integrations/source-bindings');
      check('github_event_policy_update_is_durable', githubListed.sourceBindings.some(value => value.bindingId === github.bindingId && isDeepStrictEqual(value.eventPolicy, githubPolicy)));

      const githubOutsider = githubComment('github_outsider_triggered', '@rat-things', { login: 'routing-outsider', type: 'User' });
      const githubOutsiderReply = await send(githubOutsider);
      check('github_triggered_subscribed_outsider_is_denied', githubOutsiderReply.accepted === false && githubOutsiderReply.reason === 'event_policy');
      check('github_outsider_comment_has_no_occurrence', !await occurrence(github, githubOutsider.occurrenceId));
      const allowedComment = githubComment('github_exact_actor');
      const allowedSession = await acceptedSession(allowedComment);
      check('github_exact_actor_comment_continues_subscription', allowedSession === first.sessionId);
      const allowed = await complete(allowedSession, allowedComment.occurrenceId);
      await delivered(allowed);

      const githubBotReplay = await replay(pullRequest, first);
      check('github_bot_pull_request_remains_eligible_under_exact_actor_policy', githubBotReplay.accepted === true && githubBotReplay.sessionId === first.sessionId);
      const githubBotComment = githubComment('github_bot_comment', '@rat-things', { login: 'routing-review-bot[bot]', type: 'Bot' });
      const githubBotCommentReply = await send(githubBotComment);
      check('github_bot_comment_is_ignored', githubBotCommentReply.accepted === false && githubBotCommentReply.ignored === true);
      check('github_bot_comment_has_no_occurrence', !await occurrence(github, githubBotComment.occurrenceId));

      const gitlabProjectId = '7654321';
      const gitlab = await bind({ sourceKind: 'gitlab', selector: { projectId: gitlabProjectId, mergeRequestIid: String(issue) }, environment: { type: 'openai_hosted' }, eventPolicy: { mode: 'explicit' } });
      const gitlabBeforeSubscription = gitlabNote('gitlab_unsubscribed_triggered', '@rat-things', '2468');
      const gitlabBeforeReply = await send(gitlabBeforeSubscription);
      check('gitlab_triggered_comment_without_allowlist_is_denied', gitlabBeforeReply.accepted === false && gitlabBeforeReply.reason === 'event_policy');
      check('gitlab_unsubscribed_comment_has_no_occurrence', !await occurrence(gitlab, gitlabBeforeSubscription.occurrenceId));

      const mergeRequest = gitlabMergeRequest('open', 'gitlab_bot_lifecycle', '7654', true);
      const gitlabFirst = await complete(await acceptedSession(mergeRequest), mergeRequest.occurrenceId);
      await delivered(gitlabFirst);
      const gitlabSession = gitlabFirst.sessionId;
      const gitlabLifecycleInput = gitlabFirst.integration.inputs.find(value => value.id === mergeRequest.occurrenceId);
      const gitlabOccurrence = await occurrence(gitlab, mergeRequest.occurrenceId);
      check('gitlab_bot_merge_request_has_durable_receipt_and_exact_system_actor', gitlabOccurrence?.value.sessionId === gitlabSession
        && gitlabLifecycleInput?.actor.id === 'gitlab:7654' && gitlabLifecycleInput.actor.kind === 'system',
      { sessionId: gitlabSession, turnId: gitlabFirst.turn.id });
      const gitlabSubscriptionBefore = await subscription(gitlabFirst);
      const gitlabSubscribedComment = gitlabNote('gitlab_subscribed_untriggered', '', '2468');
      const gitlabSubscribedReply = await send(gitlabSubscribedComment);
      check('gitlab_subscribed_comment_without_allowlist_is_denied', gitlabSubscribedReply.accepted === false && gitlabSubscribedReply.reason === 'event_policy');
      check('gitlab_subscribed_comment_has_no_occurrence', !await occurrence(gitlab, gitlabSubscribedComment.occurrenceId));

      const gitlabPolicy = { mode: 'explicit' as const, actors: { allow: ['gitlab:2468', 'gitlab:7654'] } };
      const gitlabUpdated = await control.put<SourceCapabilityBinding>(`/integrations/source-bindings/${gitlab.bindingId}/event-policy`, { body: { version: '1', eventPolicy: gitlabPolicy } });
      check('gitlab_owner_put_sets_exact_actor_policy', gitlabUpdated.ownerId === ownerId && isDeepStrictEqual(gitlabUpdated.eventPolicy, gitlabPolicy));
      check('gitlab_policy_update_preserves_binding_and_target', isDeepStrictEqual(bindingTarget(gitlab), bindingTarget(gitlabUpdated)));
      const gitlabSubscriptionAfter = await subscription({ sessionId: gitlabSession });
      check('gitlab_policy_update_preserves_subscription', isDeepStrictEqual(gitlabSubscriptionBefore, gitlabSubscriptionAfter));
      const gitlabOutsider = gitlabNote('gitlab_outsider_triggered', '@rat-things', '9999');
      const gitlabOutsiderReply = await send(gitlabOutsider);
      check('gitlab_triggered_subscribed_outsider_is_denied', gitlabOutsiderReply.accepted === false && gitlabOutsiderReply.reason === 'event_policy');
      check('gitlab_outsider_comment_has_no_occurrence', !await occurrence(gitlab, gitlabOutsider.occurrenceId));

      const gitlabAllowedComment = gitlabNote('gitlab_exact_actor', '', '2468');
      const gitlabAllowedSession = await acceptedSession(gitlabAllowedComment);
      check('gitlab_exact_actor_comment_continues_subscription', gitlabAllowedSession === gitlabSession);
      const gitlabAllowed = await complete(gitlabAllowedSession, gitlabAllowedComment.occurrenceId);
      await delivered(gitlabAllowed);

      const gitlabBotReplay = await replay(mergeRequest, gitlabFirst);
      check('gitlab_bot_merge_request_remains_eligible_under_exact_actor_policy', gitlabBotReplay.accepted === true && gitlabBotReplay.sessionId === gitlabSession);
      const gitlabBotNote = gitlabNote('gitlab_bot_note', '@rat-things', '7654', true);
      const gitlabBotNoteReply = await send(gitlabBotNote);
      check('gitlab_bot_comment_is_ignored', gitlabBotNoteReply.accepted === false && gitlabBotNoteReply.ignored === true);
      check('gitlab_bot_comment_has_no_occurrence', !await occurrence(gitlab, gitlabBotNote.occurrenceId));
    }

    if (scenario === 'filtering') {
      const candidateChannel = channel();
      const candidateBinding = await bind({ sourceKind: 'slack', threadScope: 'thread', selector: { teamId: team, channelId: candidateChannel }, environment: { type: 'none' }, eventPolicy: candidatePolicy(2) });
      await eventually(async () => Date.now() % 3_600_000 < 3_480_000, 'candidate_hour_budget');
      const hour = Math.floor(Date.now() / 3_600_000);
      const unresolved = 'The release is failing right now and nobody is investigating.';
      const actEvent = slackText(candidateChannel, 'message', 'U1', timestamp(), unresolved);
      const dropEvent = slackText(candidateChannel, 'message', 'U1', timestamp(), 'Good morning everyone. All incidents are resolved.');
      const capEvent = slackText(candidateChannel, 'message', 'U1', timestamp(), unresolved);
      const actId = await acceptedCandidate(actEvent);
      const replayId = await acceptedCandidate(actEvent);
      check('candidate_replay_retains_receipt', actId === replayId);
      const dropId = await acceptedCandidate(dropEvent);
      const capId = await acceptedCandidate(capEvent);
      check('candidate_admissions_share_hour', Math.floor(Date.now() / 3_600_000) === hour);
      const limit = await store.get<{ count: number }>(ownerId, 'event_candidate_limits', digest([candidateBinding.bindingId, hour]));
      check('candidate_cap_counts_once_per_occurrence', limit?.value.count === 2);
      const acted = await decided(actId, 'admitted');
      check('candidate_act_uses_configured_model', 'decision' in acted.state && acted.state.decision.act && acted.state.decision.model === required('AWS_E2E_EVENT_FILTER_MODEL_ID'));
      const act = await candidateTurn(candidateBinding, acted);
      await delivered(act);
      const dropped = await decided(dropId, 'discarded');
      check('candidate_drop_uses_configured_model', 'decision' in dropped.state && !dropped.state.decision.act && dropped.state.decision.model === required('AWS_E2E_EVENT_FILTER_MODEL_ID')
        && !['filter_error', 'hourly_cap', 'superseded_or_expired'].includes(dropped.state.decision.reason));
      await notAdmitted(candidateBinding, dropped, 'candidate_drop');
      const capped = await decided(capId, 'discarded');
      check('candidate_hourly_cap_reason', 'decision' in capped.state && capped.state.decision.reason === 'hourly_cap');
      await notAdmitted(candidateBinding, capped, 'candidate_cap');
      const quietAgent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [], multi_agent: { enabled: false },
        name: `${marker}-quiet`, instructions: 'Complete every Turn without any final assistant text. An empty final response is the required result. Do not explain, acknowledge, print a marker, substitute punctuation, create subagents, or call external services.' });
      createdAgents.add(quietAgent.id);
      const quietChannel = channel();
      const quietBinding = await bind({ sourceKind: 'slack', threadScope: 'thread', selector: { teamId: team, channelId: quietChannel }, agentId: quietAgent.id, environment: { type: 'none' }, eventPolicy: candidatePolicy(1) });
      const quietPair = slackPair(quietChannel, { user: 'U1', thread: timestamp(), text: `<@BOT> ${unresolved}` });
      checkSlackPair(quietPair.message, quietPair.mention);
      const quietId = await acceptedCandidate(quietPair.message);
      const quietCandidate = await decided(quietId, 'admitted');
      check('quiet_candidate_filter_acted', 'decision' in quietCandidate.state && quietCandidate.state.decision.act && quietCandidate.state.decision.model === required('AWS_E2E_EVENT_FILTER_MODEL_ID'));
      const quiet = await candidateTurn(quietBinding, quietCandidate, '');
      await processed(quiet);
      check('candidate_quiet_has_actual_empty_final', finalText(quiet.items).trim() === '', { sessionId: quiet.sessionId, turnId: quiet.turn.id });
      const quietReceipts = (await integration(quiet.sessionId)).inputs.filter(value => value.turnId === quiet.turn.id);
      check('candidate_quiet_all_receipts_processed', quietReceipts.length > 0 && quietReceipts.every(value => value.admission === 'candidate' && value.deliveryProcessed));
      await settleCaptures();
      check('candidate_quiet_sends_no_capture', captureCount(quiet.turn.id) === 0);
      const matchingMentionReply = await send(quietPair.mention);
      check('quiet_candidate_matching_mention_reuses_session', matchingMentionReply.accepted === true && matchingMentionReply.sessionId === quiet.sessionId);
      const quietAfterMention = await integration(quiet.sessionId);
      const quietInputs = quietAfterMention.inputs.filter(value => value.id === quietPair.mention.occurrenceId);
      const quietTurns = (await client.beta.agents.sessions.turns.list(quiet.sessionId, { limit: 100, order: 'asc' })).data;
      const quietExplicit = await store.get<{ threadKey: string }>(ownerId, 'event_explicit_receipts', digest([quietBinding.bindingId, quietPair.mention.occurrenceId]));
      const quietMarker = await store.get<EventCandidateThread>(ownerId, 'event_candidate_threads', digest([quietBinding.bindingId, quietCandidate.threadKey]));
      check('quiet_candidate_matching_mention_has_one_occurrence_and_turn', quietInputs.length === 1 && quietInputs[0]?.turnId === quiet.turn.id && quietTurns.length === 1);
      check('quiet_candidate_matching_mention_promotes_receipt', quietInputs[0]?.admission === 'explicit');
      check('quiet_candidate_matching_mention_records_explicit_precedence', quietExplicit?.value.threadKey === quietCandidate.threadKey
        && (quietMarker?.value.explicitVersion ?? 0) > quietCandidate.explicitVersion);
      await delivered(quiet);
      check('quiet_candidate_matching_mention_receives_completion_reply', captureCount(quiet.turn.id) === 1
        && [...captures.get(quiet.turn.id)!.values()].every(body => body === 'Turn completed.'));
      const explicitEmptyEvent = slackText(quietChannel, 'app_mention', 'U1', timestamp(), unresolved);
      const explicitEmpty = await complete(await acceptedSession(explicitEmptyEvent), explicitEmptyEvent.occurrenceId, '');
      check('explicit_empty_has_actual_empty_final', finalText(explicitEmpty.items).trim() === '');
      await delivered(explicitEmpty);
      check('explicit_empty_retains_completion_reply', [...captures.get(explicitEmpty.turn.id)!.values()].every(body => body === 'Turn completed.'));

      const precedenceChannel = channel();
      const precedenceBinding = await bind({ sourceKind: 'slack', threadScope: 'thread', selector: { teamId: team, channelId: precedenceChannel }, environment: { type: 'none' }, eventPolicy: candidatePolicy(1) });
      const precedenceRoot = timestamp();
      const precedencePair = slackPair(precedenceChannel, { user: 'U1', thread: precedenceRoot, text: `<@BOT> ${unresolved}` });
      checkSlackPair(precedencePair.message, precedencePair.mention);
      const queuedEvent = precedencePair.message;
      const explicitEvent = precedencePair.mention;
      let queuedId = '';
      let explicitSession = '';
      await whileOutboxPaused(async () => {
        queuedId = await acceptedCandidate(queuedEvent);
        const pending = await store.get<EventCandidate>(ownerId, 'event_candidates', queuedId);
        check('queued_candidate_is_pending_before_explicit', pending?.value.state.status === 'pending');
        explicitSession = await acceptedSession(explicitEvent);
        const queued = await store.get<EventCandidate>(ownerId, 'event_candidates', queuedId);
        const thread = await store.get<EventCandidateThread>(ownerId, 'event_candidate_threads', digest([precedenceBinding.bindingId, pending!.value.threadKey]));
        check('explicit_marker_advances_while_candidate_queued', queued?.value.state.status === 'pending'
          && (thread?.value.explicitVersion ?? 0) > pending!.value.explicitVersion,
        { candidateState: queued?.value.state.status ?? 'missing', explicitVersion: thread?.value.explicitVersion ?? 0, candidateVersion: pending!.value.explicitVersion });
      });
      const obsolete = await decided(queuedId, 'discarded');
      const explicitOccurrence = await occurrence(precedenceBinding, explicitEvent.occurrenceId);
      check('queued_candidate_loses_to_matching_explicit_mention', 'decision' in obsolete.state && obsolete.state.decision.reason === 'explicit_request_won'
        && explicitOccurrence?.value.sessionId === explicitSession);
      const explicit = await complete(explicitSession, explicitEvent.occurrenceId, reply('candidate_act'));
      const explicitTurns = (await client.beta.agents.sessions.turns.list(explicitSession, { limit: 100, order: 'asc' })).data;
      check('explicit_precedence_has_one_occurrence_and_turn', explicit.integration.inputs.length === 1 && explicit.integration.inputs[0]?.id === explicitEvent.occurrenceId
        && explicitTurns.length === 1 && explicitOccurrence?.value.sessionId === explicitSession);
      await delivered(explicit);
      quietDelivery = { quietTurnId: quiet.turn.id, explicitTurnId: explicit.turn.id };
    }
    await settleCaptures();
    for (const [turnId, messages] of captures) check('one_capture_per_delivered_turn', messages.size === 1, { turnId });
    if (quietDelivery) check('promoted_quiet_and_explicit_deliver_once', captureCount(quietDelivery.quietTurnId) === 1 && captureCount(quietDelivery.explicitTurnId) === 1);
  } catch (error) {
    proofFailed = true;
    throw error instanceof ProofFailure ? error : new ProofFailure(`Routing proof external operation failed during ${phase}${httpStatus(error) ? ` with HTTP ${httpStatus(error)}` : ''}`);
  } finally {
    let cleanupFailed = false;
    for (const agentId of createdAgents) {
      try { for await (const session of client.beta.agents.sessions.list({ agent_id: agentId, limit: 100 })) createdSessions.add(session.id); }
      catch { cleanupFailed = true; }
    }
    for (const sessionId of createdSessions) {
      try { await client.withOptions({ maxRetries: 3 }).beta.agents.sessions.delete(sessionId); }
      catch (error) { if (httpStatus(error) !== 404) cleanupFailed = true; }
    }
    for (const agentId of createdAgents) {
      try { await client.withOptions({ maxRetries: 3 }).beta.agents.delete(agentId); }
      catch (error) { if (httpStatus(error) !== 404) cleanupFailed = true; }
    }
    evidence.push({ check: 'created_resources_cleaned', passed: !cleanupFailed });
    db.destroy(); s3.destroy(); sqs.destroy();
    await mkdir(dirname(proofPath), { recursive: true });
    await writeFile(proofPath, JSON.stringify({ deployment, proofId: marker, scenario, passed: !proofFailed && !cleanupFailed,
      checks: evidence, sessions: [...createdSessions], agents: [...createdAgents], bindingIds: bindings.map(value => value.bindingId),
      bindingCleanup: 'isolated_stack_teardown', encryptedArtifacts: [...observedArtifacts],
      captures: [...captures].map(([turnId, messages]) => ({ turnId, messageIds: [...messages.keys()] })),
    }, null, 2));
    console.log(JSON.stringify({ proofId: marker, passed: !proofFailed && !cleanupFailed, artifact: proofPath }));
    if (cleanupFailed && !proofFailed) throw new ProofFailure('Disposable routing proof cleanup failed');
  }

  function check(name: string, passed: boolean, ids?: Evidence['ids']) {
    evidence.push({ check: name, passed, ...(ids ? { ids } : {}) });
    if (!passed) throw new ProofFailure(`Routing check failed: ${name}`);
  }
  function checkSlackPair(message: Fixture, mention: Fixture) {
    const messagePayload = record(JSON.parse(message.body));
    const mentionPayload = record(JSON.parse(mention.body));
    const messageEvent = record(messagePayload.event);
    const mentionEvent = record(mentionPayload.event);
    check('slack_pair_shares_message_fields_and_has_distinct_transport_ids', message.provider === 'slack' && mention.provider === 'slack'
      && message.id !== mention.id && message.occurrenceId === mention.occurrenceId
      && messagePayload.event_id !== mentionPayload.event_id && messageEvent.type === 'message' && mentionEvent.type === 'app_mention'
      && messageEvent.ts === mentionEvent.ts && messageEvent.text === mentionEvent.text
      && messageEvent.thread_ts === mentionEvent.thread_ts && messageEvent.channel === mentionEvent.channel && messageEvent.user === mentionEvent.user);
  }
  function channel() { return `C${randomUUID().replaceAll('-', '').toUpperCase()}`; }
  function timestamp() { return `${Math.floor(Date.now() / 1000)}.${String(++sequence).padStart(6, '0')}`; }
  function reply(phase: string) { return `${marker}_${phase}`; }
  function pull(action: string, sha: string, phase: string, sender = { login: 'routing-fixture-user', type: 'User' }): Fixture {
    const id = `${marker}-${++sequence}`;
    return { provider: 'github', id, event: 'pull_request', occurrenceId: `github:${id}`, body: JSON.stringify({ action, number: issue,
      repository: { full_name: repository, clone_url: repositoryUrl }, sender,
      pull_request: { title: marker, body: `REPLY=${reply(phase)}`, user: { login: sender.login }, head: { sha } },
    }) };
  }
  function githubComment(phase: string, instruction = '', user = { login: 'routing-fixture-user', type: 'User' }): Fixture {
    const id = `${marker}-${++sequence}`;
    return { provider: 'github', id, event: 'issue_comment', occurrenceId: `github:${id}`, body: JSON.stringify({ action: 'created',
      repository: { full_name: repository, clone_url: repositoryUrl }, issue: { number: issue, pull_request: {} },
      comment: { body: `${instruction} REPLY=${reply(phase)}`, user },
    }) };
  }
  function slack(channelId: string, type: 'app_mention' | 'message', user: string, thread: string, phase: string, instruction = ''): Fixture {
    return slackText(channelId, type, user, thread, `${instruction} REPLY=${reply(phase)}`);
  }
  function slackText(channelId: string, type: 'app_mention' | 'message', user: string, thread: string, text: string): Fixture {
    const id = `${marker}-${++sequence}`;
    const messageTs = timestamp();
    return { provider: 'slack', id, event: type, body: JSON.stringify({ type: 'event_callback', team_id: team, event_id: id,
      event: { type, user, channel: channelId, text: `${type === 'app_mention' ? '<@BOT> ' : ''}${text}`, ts: messageTs, thread_ts: thread },
    }), occurrenceId: `slack:${channelId}:${messageTs}` };
  }
  function slackPair(channelId: string, typeMessage: { user: string; thread: string; text: string }): { message: Fixture; mention: Fixture } {
    const messageTs = timestamp();
    const make = (type: 'app_mention' | 'message'): Fixture => {
      const id = `${marker}-${++sequence}`;
      return { provider: 'slack', id, event: type, occurrenceId: `slack:${channelId}:${messageTs}`, body: JSON.stringify({ type: 'event_callback', team_id: team, event_id: id,
        event: { type, user: typeMessage.user, channel: channelId, text: typeMessage.text, ts: messageTs, thread_ts: typeMessage.thread },
      }) };
    };
    return { message: make('message'), mention: make('app_mention') };
  }
  function gitlabProject() {
    return { id: '7654321', path_with_namespace: required('AWS_E2E_GITLAB_REPOSITORY'), git_http_url: required('AWS_E2E_GITLAB_REPOSITORY_URL') };
  }
  function gitlabMergeRequest(action: string, phase: string, userId: string, bot = false): Fixture {
    const id = `${marker}-${++sequence}`;
    const sha = required('AWS_E2E_GITLAB_SHA');
    return { provider: 'gitlab', id, event: 'Merge Request Hook', occurrenceId: `gitlab:${id}`, body: JSON.stringify({ object_kind: 'merge_request', project: gitlabProject(),
      object_attributes: { iid: issue, action, title: marker, description: `REPLY=${reply(phase)}`, last_commit: { id: sha } },
      user: { id: userId, username: bot ? 'routing-bot' : 'routing-fixture-user', bot },
    }) };
  }
  function gitlabNote(phase: string, instruction: string, userId: string, bot = false): Fixture {
    const id = `${marker}-${++sequence}`;
    return { provider: 'gitlab', id, event: 'Note Hook', occurrenceId: `gitlab:${id}`, body: JSON.stringify({ object_kind: 'note', project: gitlabProject(),
      object_attributes: { id: sequence, note: `${instruction} REPLY=${reply(phase)}`, action: 'create' },
      merge_request: { iid: issue, last_commit: { id: required('AWS_E2E_GITLAB_SHA') } },
      user: { id: userId, username: bot ? 'routing-bot' : 'outsider-fixture-user', bot },
    }) };
  }
  async function bind(input: Pick<SourceCapabilityBinding, 'sourceKind' | 'selector' | 'environment' | 'eventPolicy' | 'threadScope'> & Partial<Pick<SourceCapabilityBinding, 'agentId'>>) {
    const binding = await control.post<SourceCapabilityBinding>('/integrations/source-bindings', { body: { version: '1', agentId: [...createdAgents][0]!, ...input } });
    check('binding_owner_is_authenticated_caller', binding.ownerId.startsWith('api:') && binding.ownerId.includes(`:${account}:`)
      && (!ownerId || binding.ownerId === ownerId), { bindingId: binding.bindingId });
    ownerId = binding.ownerId;
    bindings.push(binding);
    return binding;
  }
  async function send(fixture: Fixture): Promise<IngressReply> {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = fixture.provider === 'github'
      ? { 'x-github-event': fixture.event, 'x-github-delivery': fixture.id, 'x-hub-signature-256': `sha256=${createHmac('sha256', githubSecret).update(fixture.body).digest('hex')}` }
      : fixture.provider === 'gitlab' ? gitlabHeaders(fixture)
        : { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', slackSecret).update(`v0:${ts}:${fixture.body}`).digest('hex')}` };
    phase = `ingress_${fixture.id}`;
    const admittedAt = performance.now();
    const webhookUrl = fixture.provider === 'github' ? githubUrl : fixture.provider === 'gitlab' ? required('GITLAB_WEBHOOK_URL') : slackUrl;
    const response = await fetch(webhookUrl, { method: 'POST', body: fixture.body,
      headers: { 'content-type': 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const admissionMs = Math.round(performance.now() - admittedAt);
    check('signed_ingress_acknowledged', response.status === 202, { eventId: fixture.id });
    if (fixture.provider === 'slack') check('slack_acknowledged_within_three_seconds', admissionMs < 3000, { eventId: fixture.id, admissionMs });
    return await response.json() as IngressReply;
  }
  async function acceptedSession(event: Fixture) {
    const response = await send(event);
    check('explicit_event_has_session', response.accepted === true && typeof response.sessionId === 'string', { eventId: event.id });
    createdSessions.add(response.sessionId!);
    return response.sessionId!;
  }
  async function acceptedCandidate(event: Fixture) {
    const response = await send(event);
    check('candidate_event_is_asynchronous', response.accepted === true && typeof response.candidateId === 'string' && !response.sessionId, { eventId: event.id });
    return response.candidateId!;
  }
  async function readEncrypted<T>(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T> {
    const identity = `${reference.bucket}/${reference.key}`;
    if (!observedArtifacts.has(identity)) {
      check('artifact_is_deployment_owned', reference.bucket === definitionBucket || reference.bucket === artifactBucket);
      const head = await s3.send(new HeadObjectCommand({ Bucket: reference.bucket, Key: reference.key }));
      check('observed_artifact_is_encrypted', head.ServerSideEncryption === 'aws:kms' || head.ServerSideEncryption === 'AES256');
      observedArtifacts.add(identity);
    }
    return objects.getJson<T>(reference);
  }
  async function integration(sessionId: string) {
    const saved = await store.get<SessionIntegrationState>(ownerId, 'session_integrations', sessionId);
    if (!saved) throw new ProofFailure('Accepted Session integration is missing');
    return saved.value;
  }
  async function complete(sessionId: string, inputId: string, expectedReply?: string): Promise<Completed> {
    createdSessions.add(sessionId);
    phase = `turn_${sessionId}`;
    let turn: Turn | undefined;
    await eventually(async () => {
      const state = await integration(sessionId);
      const turnId = state.inputs.find(value => value.id === inputId)?.turnId;
      if (!turnId) return false;
      ownedTurns.add(turnId);
      turn = (await client.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })).data.find(value => value.id === turnId);
      if (turn?.status === 'failed' || turn?.status === 'cancelled') throw new ProofFailure(`Routing Turn ${turn.id} ended ${turn.status}`);
      return turn?.status === 'completed';
    }, 'root_turn_completed');
    check('completed_turn_is_root', turn?.subagent_id === null, { sessionId, turnId: turn!.id });
    const items: AgentSessionItem[] = [];
    for await (const item of client.beta.agents.sessions.items.list(sessionId, { limit: 100, order: 'asc' })) if (item.turn_id === turn!.id) items.push(item);
    const saved = await integration(sessionId);
    const input = saved.inputs.find(value => value.id === inputId)!;
    if (expectedReply !== undefined) {
      check('real_model_returns_configured_reply', finalText(items).trim() === expectedReply, { sessionId, turnId: turn!.id });
    } else if (!input.text.includes('QUIET')) {
      const expected = /REPLY=([A-Za-z0-9_-]+)/.exec(input.text)?.[1];
      check('real_model_returns_requested_marker', Boolean(expected) && finalText(items).trim() === expected, { sessionId, turnId: turn!.id });
    }
    console.log(JSON.stringify({ phase: 'turn_completed', sessionId, turnId: turn!.id }));
    return { sessionId, turn: turn!, items, integration: saved };
  }
  async function processed(value: Completed) {
    await eventually(async () => {
      const receipts = (await integration(value.sessionId)).inputs.filter(input => input.turnId === value.turn.id);
      return receipts.length > 0 && receipts.every(input => input.deliveryProcessed);
    }, 'delivery_receipts_processed');
    check('delivery_processing_is_durable', true, { sessionId: value.sessionId, turnId: value.turn.id });
  }
  async function delivered(value: Completed) {
    await processed(value);
    await eventually(async () => { await collectCaptures(); return captureCount(value.turn.id) > 0; }, 'capture_delivered');
    const messages = captures.get(value.turn.id)!;
    check('delivery_matches_saved_final_text', messages.size === 1 && [...messages.values()].every(text => text === (finalText(value.items) || 'Turn completed.')),
      { sessionId: value.sessionId, turnId: value.turn.id });
  }
  async function collectCaptures() {
    const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 5 }));
    for (const message of page.Messages ?? []) {
      let parsed: ReturnType<typeof card>;
      try { parsed = card(JSON.parse(message.Body ?? '{}')); } catch { continue; }
      if (!parsed || !ownedTurns.has(parsed.turnId) || !message.MessageId || !message.ReceiptHandle) continue;
      const messages = captures.get(parsed.turnId) ?? new Map<string, string>();
      messages.set(message.MessageId, parsed.body);
      captures.set(parsed.turnId, messages);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  function captureCount(turnId: string) { return captures.get(turnId)?.size ?? 0; }
  async function settleCaptures() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) await collectCaptures();
  }
  async function checkout(value: Completed, sha: string) {
    check('checkout_observed_from_completed_command', value.items.some(item => item.type === 'command_execution' && item.status === 'completed'
      && item.exit_code === 0 && /\bgit\s+rev-parse\s+HEAD\b/.test(item.command) && item.output?.trim() === sha), { sessionId: value.sessionId, turnId: value.turn.id });
  }
  async function worker(sessionId: string, sha: string) {
    const runtime = await store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId);
    check('runtime_has_run_binding', Boolean(runtime?.value.runId));
    const run = (await db.send(new GetCommand({ TableName: runsTable, Key: { runId: runtime!.value.runId! }, ConsistentRead: true }))).Item as RunRecord | undefined;
    check('real_worker_is_bound_to_session', run?.ownerId === ownerId && run.agentsSession?.sessionId === sessionId
      && (run.execution?.backend === 'microvm' || run.execution?.backend === 'ec2') && Boolean(run.execution.id && run.execution.id !== 'pending'));
    const request = await readEncrypted<RunRequest>(run!.input);
    const launch = await readEncrypted<SessionLaunch>(run!.agentsSession!.launch);
    check('real_worker_input_has_pinned_checkout_and_model', request.repository?.url === repositoryUrl && request.repository.ref === sha
      && request.agent?.driver === 'codex' && launch.agent.model === required('AWS_E2E_CODEX_MODEL_ID') && launch.runtime?.kind === 'codex');
    const session = await client.beta.agents.sessions.retrieve(sessionId);
    check('github_session_has_managed_environment', session.environment.type === 'openai_hosted');
    if (session.environment.type !== 'openai_hosted') throw new ProofFailure('GitHub Session has no managed environment');
    const identity = { runId: run!.runId, executionId: run!.execution!.id, environmentId: session.environment.id };
    evidence.push({ check: 'worker_identity_observed', passed: true, ids: { sessionId, ...identity } });
    return identity;
  }
  async function replay(event: Fixture, original: Completed): Promise<IngressReply> {
    const before = (await client.beta.agents.sessions.turns.list(original.sessionId, { limit: 100 })).data.map(value => value.id).sort().join(',');
    const result = await send(event);
    check('duplicate_replays_original_session', result.sessionId === original.sessionId, { eventId: event.id, sessionId: original.sessionId });
    await settleCaptures();
    const after = (await client.beta.agents.sessions.turns.list(original.sessionId, { limit: 100 })).data.map(value => value.id).sort().join(',');
    check('duplicate_creates_no_turn_or_capture', before === after && captureCount(original.turn.id) === 1);
    return result;
  }
  async function transferred(previous: Completed, next: Completed) {
    const old = await integration(previous.sessionId);
    const current = await integration(next.sessionId);
    check('thread_epoch_transfers', next.sessionId !== previous.sessionId && current.epoch === (old.epoch ?? 0) + 1
      && current.previousSessionId === previous.sessionId && old.supersededBy === next.sessionId,
    { previousSessionId: previous.sessionId, sessionId: next.sessionId, epoch: current.epoch ?? -1 });
  }
  async function subscription(value: Pick<Completed, 'sessionId'>) {
    const id = (await integration(value.sessionId)).threadSubscriptionId;
    check('integration_has_subscription', Boolean(id));
    const publicValue = await control.get<ThreadSubscription & { id: string }>(`/integrations/thread-subscriptions/${id}`);
    const durable = await store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', id!);
    const { id: _id, ...publicState } = publicValue;
    check('public_subscription_matches_durable_state', isDeepStrictEqual(durable?.value, publicState));
    return publicValue;
  }
  async function occurrence(binding: SourceCapabilityBinding, inputId: string) {
    return store.get<IntegrationOccurrence>(ownerId, 'integration_occurrences', digest([binding.bindingId, inputId]));
  }
  async function decided(id: string, status: 'admitted' | 'discarded') {
    let value: EventCandidate | undefined;
    await eventually(async () => {
      value = (await store.get<EventCandidate>(ownerId, 'event_candidates', id))?.value;
      return value?.state.status === 'admitted' || value?.state.status === 'discarded';
    }, 'candidate_decided');
    check(`candidate_${status}`, value?.state.status === status, { candidateId: id });
    console.log(JSON.stringify({ phase: 'candidate_decided', candidateId: id, status: value!.state.status }));
    return value!;
  }
  async function notAdmitted(binding: SourceCapabilityBinding, candidate: EventCandidate, name: string) {
    const sessionId = `sess_${digest([binding.bindingId, candidate.threadKey]).slice(0, 32)}`;
    const [receipt, session, saved] = await Promise.all([occurrence(binding, candidate.input.id),
      store.get(ownerId, 'sessions', sessionId), store.get(ownerId, 'session_integrations', sessionId)]);
    check(`${name}_has_no_occurrence_or_session`, !receipt && !session && !saved);
  }
  async function candidateTurn(binding: SourceCapabilityBinding, candidate: EventCandidate, expectedReply = reply('candidate_act')) {
    const receipt = await occurrence(binding, candidate.input.id);
    check('admitted_candidate_has_occurrence', Boolean(receipt));
    const completed = await complete(receipt!.value.sessionId, candidate.input.id, expectedReply);
    check('candidate_admission_is_durable', completed.integration.inputs.some(value => value.id === candidate.input.id && value.admission === 'candidate'));
    return completed;
  }
  async function whileOutboxPaused(action: () => Promise<void>) {
    const expectedFunction = `arn:aws:lambda:${region}:${account}:function:${functionName}`;
    const expectedQueue = `arn:aws:sqs:${region}:${account}:${deployment}-agents.fifo`;
    const configuration = await lambda<{ FunctionArn: string; Timeout: number }>('GET', `/2015-03-31/functions/${functionName}/configuration`);
    check('outbox_drain_timeout_is_scoped', configuration.FunctionArn === expectedFunction && Number.isInteger(configuration.Timeout) && configuration.Timeout > 0 && configuration.Timeout <= 300);
    const mappings = await lambda<{ EventSourceMappings: Mapping[] }>('GET', '/2015-03-31/event-source-mappings/', undefined, { FunctionName: functionName });
    const matches = mappings.EventSourceMappings.filter(value => value.FunctionArn === expectedFunction && value.EventSourceArn === expectedQueue);
    check('exact_disposable_sqs_mapping_selected', matches.length === 1 && matches[0]?.State === 'Enabled');
    const mapping = matches[0]!;
    const path = `/2015-03-31/event-source-mappings/${mapping.UUID}`;
    try {
      await lambda('PUT', path, { Enabled: false });
      await eventually(async () => (await lambda<Mapping>('GET', path)).State === 'Disabled', 'outbox_disabled');
      await delay((configuration.Timeout + 5) * 1000);
      await action();
    } finally {
      await eventually(async () => {
        const current = await lambda<Mapping>('GET', path);
        if (current.State === 'Enabled') return true;
        if (current.State === 'Disabled') await lambda('PUT', path, { Enabled: true });
        return false;
      }, 'outbox_restored');
      check('outbox_mapping_restored', true, { mappingId: mapping.UUID });
    }
  }
  async function lambda<T>(method: string, path: string, value?: unknown, query: Record<string, string> = {}): Promise<T> {
    const host = `lambda.${region}.amazonaws.com`;
    const body = value === undefined ? undefined : JSON.stringify(value);
    const signer = new SignatureV4({ service: 'lambda', region, credentials: defaultProvider(), sha256: Sha256 });
    const signed = await signer.sign(new HttpRequest({ protocol: 'https:', hostname: host, method, path, query,
      headers: { host, 'content-type': 'application/json' }, ...(body ? { body } : {}) }));
    const url = new URL(`https://${host}${path}`);
    for (const [key, item] of Object.entries(query)) url.searchParams.set(key, item);
    const response = await fetch(url, { method, headers: signed.headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    check('lambda_mapping_api_succeeded', response.ok);
    return await response.json() as T;
  }
  async function eventually(predicate: () => Promise<boolean>, name: string) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(1000); }
    check(name, false);
  }
  function gitlabHeaders(fixture: Fixture) {
    const token = required('GITLAB_WEBHOOK_SIGNING_TOKEN');
    const encodedKey = token.startsWith('whsec_') ? token.slice('whsec_'.length) : '';
    const key = Buffer.from(encodedKey, 'base64');
    check('gitlab_standard_webhook_key_is_configured', key.length === 32 && key.toString('base64') === encodedKey);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(`${fixture.id}.${timestamp}.${fixture.body}`).digest('base64');
    return { 'x-gitlab-event': fixture.event, 'webhook-id': fixture.id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  }
}, timeoutMs * 24);

class ProofFailure extends Error {}
function required(name: string) { const value = process.env[name]; if (!value) throw new ProofFailure(`${name} is required for the routing proof`); return value; }
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bindingTarget(binding: SourceCapabilityBinding) {
  return { version: binding.version, bindingId: binding.bindingId, ownerId: binding.ownerId, sourceKind: binding.sourceKind,
    threadScope: binding.threadScope, selector: binding.selector, agentId: binding.agentId, environment: binding.environment,
    vaultIds: binding.vaultIds, destinations: binding.destinations, watchdog: binding.watchdog, connectionSetId: binding.connectionSetId };
}
function httpStatus(error: unknown): number | undefined { const value = record(error).status; return typeof value === 'number' ? value : undefined; }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function finalText(items: AgentSessionItem[]) {
  return items.flatMap(item => item.type === 'message' && item.role === 'assistant' && item.status === 'completed' && item.phase !== 'commentary'
    ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n\n');
}
function candidatePolicy(maxCandidatesPerHour: number): NonNullable<SourceCapabilityBinding['eventPolicy']> {
  return { mode: 'candidate', semantic: { policies: ['Act only on messages stating an unresolved release failure that nobody is investigating. Routine greetings and resolved incidents require no action.'], maxCandidatesPerHour } };
}
function card(value: unknown): { turnId: string; body: string } | undefined {
  const attachments = record(value).attachments;
  if (!Array.isArray(attachments)) return undefined;
  for (const attachment of attachments) {
    const body = record(record(attachment).content).body;
    if (!Array.isArray(body)) continue;
    const facts = body.flatMap(block => record(block).type === 'FactSet' && Array.isArray(record(block).facts) ? record(block).facts as unknown[] : []);
    const turn = facts.map(record).find(fact => fact.title === 'Turn');
    const text = record(body[1]).text;
    if (typeof turn?.value === 'string' && typeof text === 'string') return { turnId: turn.value, body: text };
  }
  return undefined;
}
async function parentCommit(repository: string, sha: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}`, { headers: { accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new ProofFailure('Public GitHub commit lookup failed; provide AWS_E2E_GITHUB_PREVIOUS_SHA');
  const value = record(await response.json());
  const parent = Array.isArray(value.parents) ? record(value.parents[0]).sha : undefined;
  if (typeof parent !== 'string') throw new ProofFailure('GitHub commit has no parent; provide AWS_E2E_GITHUB_PREVIOUS_SHA');
  return parent;
}
