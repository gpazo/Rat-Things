import { createHash } from 'node:crypto';
import type { RunRequest } from '../domain/contracts.js';
import { isRecord } from '../domain/validation.js';
import { isAgentResultMessage } from './result-marker.js';

export interface NormalizedWebhookRun {
  ownerId: string;
  idempotencyKey: string;
  request: RunRequest;
}

export function normalizeGitHubWebhook(
  eventName: string,
  deliveryId: string,
  payload: unknown,
  credentialSecretArn?: string,
  commentTrigger?: string,
): NormalizedWebhookRun | undefined {
  if (!isRecord(payload)) return undefined;
  const repository = record(payload.repository);
  const fullName = text(repository?.full_name);
  const cloneUrl = text(repository?.clone_url);
  if (!fullName || !cloneUrl) return undefined;
  const installationId = scalarId(record(payload.installation)?.id);
  const ownerId = `github:${installationId ?? fullName.split('/')[0] ?? fullName}`;

  if (eventName === 'pull_request') {
    const action = text(payload.action);
    if (!action || !['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) return undefined;
    const pull = record(payload.pull_request);
    const issueNumber = positiveNumber(payload.number);
    const headSha = text(record(pull?.head)?.sha);
    if (!pull || !issueNumber || !headSha) return undefined;
    const title = text(pull.title) ?? '';
    const description = text(pull.body) ?? '';
    const author = text(record(pull.user)?.login) ?? 'unknown';
    return {
      ownerId,
      idempotencyKey: safeIdempotencyKey('github', deliveryId),
      request: {
        version: '1',
        prompt: [
          `Review GitHub pull request #${issueNumber} in ${fullName}.`,
          `Title: ${title}`,
          `Author: ${author}`,
          description ? `Description:\n${description}` : '',
          'Inspect the checked-out diff and repository instructions. Identify concrete correctness, security, and test-coverage issues. Return concise Markdown with file and line references. Do not modify the repository.',
        ].filter(Boolean).join('\n\n'),
        repository: compactRepository({
          provider: 'github',
          url: cloneUrl,
          ref: headSha,
          baseRef: text(record(pull.base)?.ref),
          installationId,
          credentialSecretArn,
        }),
        agent: { sandbox: 'read-only' },
        source: compactSource({
          kind: 'github',
          deliveryId,
          event: eventName,
          repository: fullName,
          issueNumber,
          installationId,
        }),
        metadata: { action },
      },
    };
  }

  if (eventName === 'issue_comment' && payload.action === 'created') {
    const issue = record(payload.issue);
    const comment = record(payload.comment);
    const issueNumber = positiveNumber(issue?.number);
    const body = text(comment?.body);
    if (!issueNumber || !body || !isRecord(issue?.pull_request)) return undefined;
    const trigger = commentTrigger?.trim();
    if (!trigger || !body.toLowerCase().includes(trigger.toLowerCase())) return undefined;
    if (isAgentResultMessage(body) || text(record(comment?.user)?.type)?.toLowerCase() === 'bot') return undefined;
    return {
      ownerId,
      idempotencyKey: safeIdempotencyKey('github', deliveryId),
      request: {
        version: '1',
        prompt: [
          `Respond to this request on GitHub pull request #${issueNumber} in ${fullName}:`,
          body,
          'Inspect the repository as needed. Return a concise Markdown response suitable for the pull-request thread.',
        ].join('\n\n'),
        repository: compactRepository({
          provider: 'github',
          url: cloneUrl,
          ref: `refs/pull/${issueNumber}/head`,
          installationId,
          credentialSecretArn,
        }),
        agent: { sandbox: 'read-only' },
        source: compactSource({
          kind: 'github',
          deliveryId,
          event: eventName,
          repository: fullName,
          issueNumber,
          installationId,
        }),
      },
    };
  }
  return undefined;
}

export function normalizeGitLabWebhook(
  eventName: string,
  deliveryId: string,
  payload: unknown,
  credentialSecretArn?: string,
  commentTrigger?: string,
): NormalizedWebhookRun | undefined {
  if (!isRecord(payload)) return undefined;
  const project = record(payload.project);
  const projectId = scalarId(project?.id);
  const path = text(project?.path_with_namespace);
  const cloneUrl = text(project?.git_http_url) ?? appendGit(text(project?.web_url));
  if (!projectId || !path || !cloneUrl) return undefined;
  const ownerId = `gitlab:${projectId}`;

  if (payload.object_kind === 'merge_request') {
    const attributes = record(payload.object_attributes);
    const action = text(attributes?.action);
    if (action && !['open', 'reopen', 'update', 'approved'].includes(action)) return undefined;
    const iid = positiveNumber(attributes?.iid);
    const sha = text(record(attributes?.last_commit)?.id);
    if (!iid || !sha) return undefined;
    return {
      ownerId,
      idempotencyKey: safeIdempotencyKey('gitlab', deliveryId),
      request: {
        version: '1',
        prompt: [
          `Review GitLab merge request !${iid} in ${path}.`,
          `Title: ${text(attributes?.title) ?? ''}`,
          text(attributes?.description) ? `Description:\n${text(attributes?.description)}` : '',
          'Inspect the checked-out diff and repository instructions. Identify concrete correctness, security, and test-coverage issues. Return concise Markdown with file and line references. Do not modify the repository.',
        ].filter(Boolean).join('\n\n'),
        repository: compactRepository({
          provider: 'gitlab',
          url: cloneUrl,
          ref: sha,
          baseRef: text(attributes?.target_branch),
          credentialSecretArn,
        }),
        agent: { sandbox: 'read-only' },
        source: { kind: 'gitlab', event: eventName, projectId, mergeRequestIid: iid },
        metadata: { action: action ?? 'unknown' },
      },
    };
  }

  if (payload.object_kind === 'note') {
    const attributes = record(payload.object_attributes);
    const mergeRequest = record(payload.merge_request);
    const body = text(attributes?.note);
    const iid = positiveNumber(mergeRequest?.iid);
    if (!body || !iid) return undefined;
    const trigger = commentTrigger?.trim();
    if (!trigger || !body.toLowerCase().includes(trigger.toLowerCase())) return undefined;
    if (isAgentResultMessage(body) || record(payload.user)?.bot === true) return undefined;
    return {
      ownerId,
      idempotencyKey: safeIdempotencyKey('gitlab', deliveryId),
      request: {
        version: '1',
        prompt: [
          `Respond to this request on GitLab merge request !${iid} in ${path}:`,
          body,
          'Inspect the repository as needed. Return a concise Markdown response suitable for the merge-request thread.',
        ].join('\n\n'),
        repository: compactRepository({
          provider: 'gitlab',
          url: cloneUrl,
          ref: text(record(mergeRequest?.last_commit)?.id) ?? `refs/merge-requests/${iid}/head`,
          credentialSecretArn,
        }),
        agent: { sandbox: 'read-only' },
        source: { kind: 'gitlab', event: eventName, projectId, mergeRequestIid: iid },
      },
    };
  }
  return undefined;
}

export function normalizeTeamsWebhook(payload: unknown): NormalizedWebhookRun | undefined {
  if (!isRecord(payload)) return undefined;
  const activityId = text(payload.id);
  const conversationId = text(record(payload.conversation)?.id);
  const senderId = text(record(payload.from)?.id);
  const prompt = stripMarkup(text(payload.text) ?? '');
  if (!activityId || !conversationId || !prompt) return undefined;
  const channelData = record(payload.channelData);
  const tenantId = text(record(channelData?.tenant)?.id);
  const teamId = text(record(channelData?.team)?.id);
  const channelId = text(record(channelData?.channel)?.id);
  if (!tenantId || !senderId) return undefined;
  return {
    ownerId: `teams:${tenantId}:${senderId}`,
    idempotencyKey: safeIdempotencyKey('teams', activityId),
    request: {
      version: '1',
      prompt,
      agent: { sandbox: 'read-only' },
      source: compactSource({
        kind: 'teams',
        tenantId,
        teamId,
        channelId,
        conversationId,
        activityId,
        senderId,
      }),
    },
  };
}

export function normalizeSlackEvent(payload: unknown): NormalizedWebhookRun | undefined {
  if (!isRecord(payload)) return undefined;
  const event = record(payload.event);
  const eventId = text(payload.event_id);
  const channelId = text(event?.channel);
  const prompt = stripSlackMention(text(event?.text) ?? '');
  if (
    event?.type !== 'app_mention' ||
    event.bot_id !== undefined ||
    event.bot_profile !== undefined ||
    event.subtype === 'bot_message' ||
    !eventId ||
    !channelId ||
    !prompt
  ) return undefined;
  const teamId = text(payload.team_id);
  const userId = text(event.user);
  if (!teamId || !userId) return undefined;
  const threadTs = text(event.thread_ts) ?? text(event.ts);
  return {
    ownerId: `slack:${teamId}:${userId}`,
    idempotencyKey: safeIdempotencyKey('slack', eventId),
    request: {
      version: '1',
      prompt,
      agent: { sandbox: 'read-only' },
      source: compactSource({
        kind: 'slack',
        teamId,
        channelId,
        threadTs,
        eventId,
        userId,
      }),
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function appendGit(value: string | undefined): string | undefined {
  return value ? `${value.replace(/\/$/, '')}.git` : undefined;
}

function stripMarkup(value: string): string {
  return value.replace(/<at>.*?<\/at>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripSlackMention(value: string): string {
  return value.replace(/<@[A-Z0-9]+>/gi, '').replace(/\s+/g, ' ').trim();
}

function compactRepository(value: {
  provider: 'github' | 'gitlab';
  url: string;
  ref?: string | undefined;
  baseRef?: string | undefined;
  installationId?: string | undefined;
  credentialSecretArn?: string | undefined;
}): NonNullable<RunRequest['repository']> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as unknown as NonNullable<RunRequest['repository']>;
}

function compactSource(value: Record<string, unknown>): NonNullable<RunRequest['source']> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as unknown as NonNullable<RunRequest['source']>;
}

function safeIdempotencyKey(namespace: string, value: string): string {
  const direct = `${namespace}:${value}`;
  return /^[A-Za-z0-9._:-]{1,200}$/.test(direct)
    ? direct
    : `${namespace}:sha256:${createHash('sha256').update(value).digest('hex')}`;
}
