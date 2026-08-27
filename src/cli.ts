#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { CachedSecretReader } from './adapters/aws-runtime.js';
import { fetchSharedResource } from './adapters/publication-client.js';
import { CredentialBroker } from './credentials/broker.js';
import type {
  AgentDriverName,
  RunRecord,
  RunRequest,
  SandboxMode,
} from './domain/contracts.js';
import type {
  ConnectionAccessRequest,
  IntegrationAuthScheme,
  IntegrationAccessRequest,
  IntegrationPermissionPreset,
} from './domain/capabilities.js';
import { INTEGRATION_PERMISSION_PRESETS } from './domain/capabilities.js';
import type { IntegrationPluginManifest } from './plugins/integration-types.js';
import type {
  PublicAgentActivity,
  PublicAgentRuntimeSnapshot,
  PublicPendingAgentRequest,
} from './core/agent-activity-projection.js';
import { isTerminal } from './domain/state.js';
import { parseRunRequest } from './domain/validation.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from './plugins/capability-profiles.js';
import { driverFor } from './runner/agent-driver.js';
import { loadCodexBedrockToken } from './runner/bedrock-auth.js';
import { codexAuthMode, localCodexAuthMode } from './runner/codex-auth.js';
import { localArtifactPaths, prepareArtifactDirectory } from './runner/artifacts.js';
import { collectWorkspacePatch, prepareWorkspace } from './runner/workspace.js';

interface Arguments {
  command: string;
  values: Map<string, string>;
  multiple: Map<string, string[]>;
  flags: Set<string>;
  positionals: string[];
}

interface ConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  conversation: {
    status: 'idle' | 'pending' | 'running' | 'awaiting_resume' | 'failed';
    pendingCount: number;
    session?: { state: 'running' | 'suspended' | 'unknown' };
  };
  run?: RunRecord;
}

interface ArtifactMetadata {
  id: string;
  path: string;
  mediaType: string;
  bytes: number;
  createdAt: string;
  sourceRunId: string;
  sha256: string;
}

interface ArtifactDescriptor extends ArtifactMetadata {
  url: string;
  expiresAt: string;
  primaryPath?: string;
  paths?: string[];
}

interface PublicConversationSummary {
  conversationId: string;
  title: string;
  threadKey?: string;
  status: 'idle' | 'pending' | 'running' | 'awaiting_resume' | 'failed';
  pendingCount: number;
  sourceKind: 'api' | 'github' | 'gitlab' | 'teams' | 'slack';
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  lastMessagePreview?: string;
}

interface PublicConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  messageId?: string;
  receivedAt?: string;
  replyToMessageId?: string;
  reactions?: Array<{ emoji: string; reacted: boolean }>;
  attachments?: Array<{ id: string }>;
}

interface PublicConversationDetail extends PublicConversationSummary {
  activeRunId?: string;
  transcript: {
    messages: PublicConversationMessage[];
    compactedMessages: number;
    nextToken?: string;
  };
}

interface ConversationAttachment {
  name: string;
  mediaType: string;
  base64: string;
  sha256: string;
}

const commands = new Set([
  'local',
  'chat',
  'submit',
  'get',
  'cancel',
  'watch',
  'steer',
  'interrupt',
  'respond',
  'computer',
  'conversations',
  'conversation',
  'console',
  'takeover',
  'handback',
  'computer-act',
  'teach-start',
  'teach-stop',
  'teach-discard',
  'plugins',
  'profiles',
  'connections',
  'connect',
  'grant',
  'rotate',
  'revoke',
  'connection-sets',
  'connection-set',
  'source-bindings',
  'bind-source',
  'things',
  'thing',
  'thing-create',
  'thing-update',
  'thing-version',
  'thing-versions',
  'thing-test',
  'thing-publish',
  'thing-release',
  'thing-run',
  'thing-pause',
  'thing-resume',
  'thing-archive',
  'thing-explain',
  'routines',
  'routine',
  'routine-create',
  'routine-run',
  'routine-pause',
  'routine-resume',
  'routine-delete',
  'output',
  'artifact',
  'files',
  'file',
  'publish',
  'list',
  'doctor',
  'help',
]);

const booleanOptions = new Set([
  'all',
  'events',
  'follow',
  'help',
  'json',
  'browser',
  'network',
  'new',
  'no-browser',
  'no-network',
  'no-wait',
  'output',
  'patch',
  'raw',
  'clear',
  'submit',
  'wait',
]);

const repeatableOptions = new Set([
  'allow-operation',
  'answer',
  'answer-stdin',
  'app',
  'attach',
  'connection',
  'deny-operation',
  'mcp',
  'skill',
]);

const valueOptions = new Set([
  'access',
  'after',
  'alias',
  'api-url',
  'auth-scheme',
  'backend',
  'base-ref',
  'codex-auth',
  'connection-set',
  'conversation',
  'credential-file',
  'credential-secret-arn',
  'delivery',
  'delta-x',
  'delta-y',
  'download',
  'driver',
  'entrypoint',
  'file',
  'goal',
  'idempotency-key',
  'key',
  'limit',
  'milliseconds',
  'model',
  'name',
  'next-token',
  'personality',
  'poll-seconds',
  'port',
  'poster',
  'profile',
  'prompt',
  'provider',
  'reasoning-effort',
  'reasoning-summary',
  'ref',
  'region',
  'reply-to',
  'repo',
  'result',
  'run',
  'sandbox',
  'screenshot',
  'target',
  'test-run',
  'text',
  'thread',
  'timeout',
  'title',
  'value',
  'visibility',
  'wait-timeout',
  'web-search',
  'workspace',
  'x',
  'y',
]);

async function main(): Promise<void> {
  const args = parseArguments(normalizeArguments(process.argv.slice(2)));
  if (args.values.has('api-url')) {
    process.env.RAT_THINGS_API_URL = args.values.get('api-url');
  }
  if (args.values.has('region')) process.env.AWS_REGION = args.values.get('region');
  if (args.flags.has('help')) {
    if (args.command === 'computer') computerHelp();
    else if (args.command === 'conversation' || args.command === 'conversations') conversationHelp();
    else if (args.command === 'chat') chatHelp();
    else if (args.command === 'watch' || args.command === 'respond') runInteractionHelp();
    else help(args.flags.has('all'));
    return;
  }
  validateRootPositionals(args);
  switch (args.command) {
    case 'local':
      await local(args);
      return;
    case 'chat':
      await chat(args);
      return;
    case 'submit':
      await submit(args);
      return;
    case 'get':
      print(await api(`/v1/runs/${requiredPositional(args, 0, 'run ID')}`, 'GET'));
      return;
    case 'cancel':
      print(await api(`/v1/runs/${requiredPositional(args, 0, 'run ID')}/cancel`, 'POST'));
      return;
    case 'watch':
      await watch(args);
      return;
    case 'steer':
      await steer(args);
      return;
    case 'interrupt':
      print(await api(
        `/v1/runs/${encodeURIComponent(requiredPositional(args, 0, 'run ID'))}/interrupt`,
        'POST',
        {},
      ));
      return;
    case 'respond':
      await respond(args);
      return;
    case 'computer':
      await computerCommand(args);
      return;
    case 'conversations':
      await conversationsCommand(args);
      return;
    case 'conversation':
      await conversationCommand(args);
      return;
    case 'console':
      await openConsole(args);
      return;
    case 'takeover':
      await setComputerControl(args, 'human');
      return;
    case 'handback':
      await setComputerControl(args, 'agent');
      return;
    case 'computer-act':
      await computerAct(args);
      return;
    case 'teach-start':
      await teachStart(args);
      return;
    case 'teach-stop':
      await teachStop(args, false);
      return;
    case 'teach-discard':
      await teachStop(args, true);
      return;
    case 'plugins':
      print(await api('/v1/integrations/plugins', 'GET'));
      return;
    case 'profiles':
      print(await api('/v1/capability-profiles', 'GET'));
      return;
    case 'connections':
      print(await api('/v1/integrations/connections', 'GET'));
      return;
    case 'connect':
      await connect(args);
      return;
    case 'grant':
      print(await api(
        `/v1/integrations/connections/${encodeURIComponent(requiredPositional(args, 0, 'connection ID or alias'))}/grant`,
        'POST',
        await requiredJsonFile(args),
      ));
      return;
    case 'rotate':
      await rotateCredential(args);
      return;
    case 'revoke':
      print(await api(
        `/v1/integrations/connections/${encodeURIComponent(requiredPositional(args, 0, 'connection ID or alias'))}/revoke`,
        'POST',
        {},
      ));
      return;
    case 'connection-sets':
      print(await api('/v1/integrations/connection-sets', 'GET'));
      return;
    case 'connection-set':
      print(await api('/v1/integrations/connection-sets', 'POST', await requiredJsonFile(args)));
      return;
    case 'source-bindings':
      print(await api('/v1/integrations/source-bindings', 'GET'));
      return;
    case 'bind-source':
      print(await api('/v1/integrations/source-bindings', 'POST', await requiredJsonFile(args)));
      return;
    case 'things': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      if (args.flags.has('all')) query.set('includeArchived', 'true');
      print(await api(`/v1/things${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'thing':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}`,
        'GET',
      ));
      return;
    case 'thing-create':
      print(await api('/v1/things', 'POST', await requiredJsonFile(args)));
      return;
    case 'thing-update': {
      const thingId = encodeURIComponent(requiredPositional(args, 0, 'Thing ID'));
      const current = await api(`/v1/things/${thingId}`, 'GET');
      print(await api(
        `/v1/things/${thingId}/versions`,
        'POST',
        {
          version: '1',
          expectedDraftRevision: thingDraftRevision(current),
          spec: await requiredJsonFile(args),
        },
      ));
      return;
    }
    case 'thing-version':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/versions/${encodeURIComponent(requiredPositional(args, 1, 'revision'))}`,
        'GET',
      ));
      return;
    case 'thing-versions':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/versions`,
        'GET',
      ));
      return;
    case 'thing-explain':
      {
        const target = args.values.get('target');
        if (target && target !== 'draft' && target !== 'active') {
          throw new Error('--target must be draft or active');
        }
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/explain${target ? `?target=${target}` : ''}`,
        'GET',
      ));
      return;
      }
    case 'thing-test':
    case 'thing-run': {
      const headers: Record<string, string> = {};
      const key = args.values.get('idempotency-key');
      if (key) headers['idempotency-key'] = key;
      const run = await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/${args.command === 'thing-test' ? 'test' : 'run'}`,
        'POST',
        {},
        headers,
      ) as RunRecord;
      const result = args.flags.has('wait') ? await waitForRun(run, args) : run;
      print(result);
      if (args.flags.has('wait') && result.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    case 'thing-publish': {
      const thingId = encodeURIComponent(requiredPositional(args, 0, 'Thing ID'));
      const current = await api(`/v1/things/${thingId}`, 'GET');
      const draft = thingDraftIdentity(current);
      const testRunId = args.values.get('test-run');
      if (!testRunId) {
        throw new Error('--test-run RUN_ID is required; use thing-release to test and publish in one command');
      }
      print(await api(
        `/v1/things/${thingId}/publish`,
        'POST',
        {
          version: '1',
          expectedDraftRevision: draft.revision,
          expectedSpecHash: draft.specHash,
          testRunId,
        },
      ));
      return;
    }
    case 'thing-release':
      await releaseThing(args);
      return;
    case 'thing-pause':
    case 'thing-resume':
    case 'thing-archive': {
      const operation = args.command.slice('thing-'.length);
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/${operation}`,
        'POST',
        {},
      ));
      return;
    }
    case 'routines': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      print(await api(`/v1/routines${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'routine':
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}`,
        'GET',
      ));
      return;
    case 'routine-create':
      print(await api('/v1/routines', 'POST', await requiredJsonFile(args)));
      return;
    case 'routine-run': {
      const headers: Record<string, string> = {};
      const key = args.values.get('idempotency-key');
      if (key) headers['idempotency-key'] = key;
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}/run`,
        'POST',
        {},
        headers,
      ));
      return;
    }
    case 'routine-pause':
    case 'routine-resume':
    case 'routine-delete': {
      const operation = args.command.slice('routine-'.length);
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}/${operation}`,
        'POST',
        {},
      ));
      return;
    }
    case 'output':
      await writeArtifact(requiredPositional(args, 0, 'run ID'), 'output');
      return;
    case 'artifact':
      await writeArtifact(
        requiredPositional(args, 0, 'run ID'),
        requiredPositional(args, 1, 'artifact name'),
      );
      return;
    case 'files':
      await listFiles(args);
      return;
    case 'file':
      await file(args);
      return;
    case 'publish':
      await publish(args);
      return;
    case 'list': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      print(await api(`/v1/runs${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'doctor':
      await doctor(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      help(args.flags.has('all'));
      return;
    default:
      throw new Error(`unknown command ${JSON.stringify(args.command)}; run rat-things help`);
  }
}

async function chat(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    flags: ['browser', 'json', 'network', 'new', 'no-browser', 'no-network', 'no-wait'],
    values: [
      'connection-set', 'conversation', 'delivery', 'driver', 'file', 'idempotency-key', 'model',
      'personality', 'poll-seconds', 'profile', 'prompt', 'reasoning-effort', 'reasoning-summary',
      'reply-to', 'sandbox', 'thread', 'wait-timeout', 'web-search',
    ],
    multiple: [
      'allow-operation', 'app', 'attach', 'connection', 'deny-operation', 'mcp', 'skill',
    ],
  });
  if (args.values.has('file') && (args.values.has('prompt') || args.positionals.length > 0)) {
    throw new Error('chat accepts either --file REQUEST.json or prompt text, not both');
  }
  if (args.values.has('prompt') && args.positionals.length > 0) {
    throw new Error('chat accepts prompt text either through --prompt or positionally, not both');
  }
  if (args.flags.has('new') && (args.values.has('thread') || args.values.has('conversation'))) {
    throw new Error('--new cannot be combined with --thread or --conversation');
  }
  const conversationId = args.flags.has('new')
    ? `thread-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    : args.values.get('thread') ?? args.values.get('conversation') ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationId)) {
    throw new Error('thread must be 1-128 safe ASCII characters');
  }
  if (args.flags.has('new')) process.stderr.write(`thread=${conversationId}\n`);
  const messageId = args.values.get('idempotency-key') ?? randomUUID();
  const encodedConversation = encodeURIComponent(conversationId);
  const request = await conversationRequestFromArguments(args) as Record<string, unknown>;
  const delivery = args.values.get('delivery');
  if (delivery !== undefined && delivery !== 'interrupt' && delivery !== 'defer') {
    throw new Error('--delivery must be interrupt or defer');
  }
  const attachments = await conversationAttachments(args);
  const replyToMessageId = args.values.get('reply-to');
  if (replyToMessageId !== undefined && !replyToMessageId.trim()) {
    throw new Error('--reply-to cannot be empty');
  }
  const run = await api(
    '/v1/runs',
    'POST',
    {
      ...request,
      thread: {
        key: conversationId,
        ...(delivery ? { delivery } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    },
    { 'idempotency-key': messageId },
  ) as RunRecord;
  if (args.flags.has('no-wait')) {
    print(run);
    return;
  }

  const interval = positiveNumber(args.values.get('poll-seconds') ?? '2', 'poll-seconds');
  const waitSeconds = positiveNumber(
    args.values.get('wait-timeout') ?? '2400',
    'wait-timeout',
  );
  const deadline = Date.now() + waitSeconds * 1_000;
  const statusPath = `/v1/conversations/${encodedConversation}/messages/${encodeURIComponent(messageId)}`;
  let lastProgress = '';
  while (Date.now() < deadline) {
    const current = await api(statusPath, 'GET') as ConversationMessageStatus;
    const progress = [
      `message=${current.state}`,
      `conversation=${current.conversation.status}`,
      current.run ? `run=${current.run.status}` : 'run=unscheduled',
      current.conversation.session ? `microvm=${current.conversation.session.state}` : undefined,
    ].filter(Boolean).join(' ');
    if (progress !== lastProgress) {
      process.stderr.write(`${terminalText(progress)}\n`);
      lastProgress = progress;
    }
    if (current.state === 'dead_letter') {
      throw new Error(`conversation message ${messageId} was dead-lettered`);
    }
    if (current.run && isTerminal(current.run.status)) {
      if (current.run.status !== 'succeeded') {
        print(current.run);
        process.exitCode = 1;
        return;
      }
      const completed = current.conversation.status === 'idle' &&
        current.conversation.pendingCount === 0 &&
        current.conversation.session?.state === 'suspended';
      if (completed) {
        if (args.flags.has('json')) print(current);
        else {
          await writeArtifact(current.run.runId, 'output');
        }
        return;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
  }
  throw new Error(
    `conversation message ${messageId} did not complete within ${waitSeconds} seconds`,
  );
}

async function conversationsCommand(args: Arguments): Promise<void> {
  const subcommand = args.positionals[0] ?? 'list';
  const nested = withPositionals(args, args.positionals.slice(1));
  if (subcommand === 'help') {
    conversationHelp();
    return;
  }
  if (subcommand === 'search') {
    validateCommandOptions(nested, { flags: ['json'], values: ['limit', 'query'] });
    if (nested.values.has('query') && nested.positionals.length > 0) {
      throw new Error('conversation search accepts the query either through --query or positionally, not both');
    }
    const queryText = nested.values.get('query') ?? nested.positionals.join(' ');
    if (!queryText.trim()) throw new Error('conversation search query is required');
    const query = new URLSearchParams({ q: queryText });
    if (nested.values.has('limit')) {
      query.set('limit', String(positiveNumber(nested.values.get('limit') as string, 'limit')));
    }
    const result = await api(`/v1/conversations/search?${query}`, 'GET') as {
      query: string;
      items: Array<{
        conversation: PublicConversationSummary;
        matches: Array<{
          kind: 'message' | 'file';
          snippet: string;
          occurredAt: string;
          role?: 'user' | 'assistant';
          artifactId?: string;
        }>;
      }>;
    };
    if (nested.flags.has('json')) print(result);
    else renderConversationSearch(result);
    return;
  }
  if (subcommand !== 'list') {
    throw new Error('conversations requires list, search, or help');
  }
  validateCommandOptions(nested, {
    flags: ['all', 'json'],
    values: ['limit', 'next-token', 'visibility'],
  });
  validatePositionals(nested, 0, 0, 'conversations list');
  if (nested.flags.has('all') && nested.values.has('visibility')) {
    throw new Error('--all cannot be combined with --visibility');
  }
  const visibility = nested.values.get('visibility') ?? (nested.flags.has('all') ? 'all' : 'visible');
  if (!['visible', 'hidden', 'all'].includes(visibility)) {
    throw new Error('--visibility must be visible, hidden, or all');
  }
  const query = new URLSearchParams({ visibility });
  if (nested.values.has('limit')) {
    query.set('limit', String(positiveNumber(nested.values.get('limit') as string, 'limit')));
  }
  if (nested.values.has('next-token')) {
    query.set('nextToken', nested.values.get('next-token') as string);
  }
  const result = await api(`/v1/conversations?${query}`, 'GET') as {
    items: PublicConversationSummary[];
    nextToken?: string;
  };
  if (nested.flags.has('json')) print(result);
  else renderConversationList(result);
}

async function conversationCommand(args: Arguments): Promise<void> {
  const subcommand = args.positionals[0];
  if (!subcommand || subcommand === 'help') {
    conversationHelp();
    return;
  }
  const nested = withPositionals(args, args.positionals.slice(1));
  if (subcommand === 'show') {
    validateCommandOptions(nested, { flags: ['json'], values: ['limit', 'next-token'] });
    validatePositionals(nested, 1, 1, 'conversation show PUBLIC_ID');
    const conversationId = publicConversationId(nested, 0);
    const query = new URLSearchParams();
    if (nested.values.has('limit')) {
      query.set('limit', String(positiveNumber(nested.values.get('limit') as string, 'limit')));
    }
    if (nested.values.has('next-token')) {
      query.set('nextToken', nested.values.get('next-token') as string);
    }
    const detail = await api(
      `/v1/conversations/${conversationId}${query.size > 0 ? `?${query}` : ''}`,
      'GET',
    ) as PublicConversationDetail;
    if (nested.flags.has('json')) print(detail);
    else renderConversationDetail(detail);
    return;
  }
  if (subcommand === 'sources') {
    validateCommandOptions(nested, { flags: ['json'] });
    validatePositionals(nested, 1, 1, 'conversation sources PUBLIC_ID');
    const conversationId = publicConversationId(nested, 0);
    const collected = await conversationSources(conversationId);
    if (nested.flags.has('json')) print({ conversationId, ...collected });
    else renderConversationSources(collected);
    return;
  }
  if (['pin', 'unpin', 'hide', 'unhide', 'read', 'unread'].includes(subcommand)) {
    validateCommandOptions(nested, {});
    validatePositionals(nested, 1, 1, `conversation ${subcommand} PUBLIC_ID`);
    const conversationId = publicConversationId(nested, 0);
    const organization = subcommand === 'pin'
      ? { pinned: true }
      : subcommand === 'unpin'
        ? { pinned: false }
        : subcommand === 'hide'
          ? { hidden: true }
          : subcommand === 'unhide'
            ? { hidden: false }
            : { read: subcommand === 'read' };
    print(await api(
      `/v1/conversations/${conversationId}/organization`,
      'POST',
      organization,
    ));
    return;
  }
  if (subcommand === 'react' || subcommand === 'unreact') {
    validateCommandOptions(nested, {});
    validatePositionals(nested, 3, 3, `conversation ${subcommand} PUBLIC_ID MESSAGE_ID EMOJI`);
    const conversationId = publicConversationId(nested, 0);
    const messageId = encodeURIComponent(requiredPositional(nested, 1, 'message ID'));
    const emoji = requiredPositional(nested, 2, 'reaction emoji');
    if (!['👍', '❤️', '🎉', '👀'].includes(emoji)) {
      throw new Error('reaction emoji must be one of 👍, ❤️, 🎉, or 👀');
    }
    print(await api(
      `/v1/conversations/${conversationId}/messages/${messageId}/reactions`,
      'POST',
      { emoji, reacted: subcommand === 'react' },
    ));
    return;
  }
  throw new Error('conversation requires show, sources, pin, unpin, hide, unhide, read, unread, react, or unreact');
}

function renderConversationList(result: {
  items: PublicConversationSummary[];
  nextToken?: string;
}): void {
  if (result.items.length === 0) {
    process.stdout.write('No conversations found.\n');
    return;
  }
  for (const conversation of result.items) {
    const markers = [
      conversation.pinned ? 'pinned' : undefined,
      conversation.hidden ? 'hidden' : undefined,
      conversation.unread ? 'unread' : undefined,
    ].filter(Boolean).join(', ');
    process.stdout.write(`${terminalText(conversation.conversationId)}\n`);
    process.stdout.write(`  ${terminalText(conversation.title)} · ${terminalText(conversation.status)} · ${terminalText(conversation.sourceKind)}`);
    if (markers) process.stdout.write(` · ${markers}`);
    process.stdout.write(`\n  updated ${terminalText(conversation.updatedAt)}`);
    if (conversation.threadKey) process.stdout.write(` · thread ${terminalText(conversation.threadKey)}`);
    process.stdout.write('\n');
    if (conversation.lastMessagePreview) {
      process.stdout.write(`  ${singleLine(conversation.lastMessagePreview, 180)}\n`);
    }
  }
  if (result.nextToken) process.stdout.write(`\nNext token: ${terminalText(result.nextToken)}\n`);
}

function renderConversationSearch(result: {
  query: string;
  items: Array<{
    conversation: PublicConversationSummary;
    matches: Array<{ kind: 'message' | 'file'; snippet: string; role?: string; artifactId?: string }>;
  }>;
}): void {
  if (result.items.length === 0) {
    process.stdout.write(`No conversations matched ${JSON.stringify(terminalText(result.query))}.\n`);
    return;
  }
  process.stdout.write(`Matches for ${JSON.stringify(terminalText(result.query))}\n\n`);
  for (const item of result.items) {
    process.stdout.write(`${terminalText(item.conversation.conversationId)}\n`);
    process.stdout.write(`  ${terminalText(item.conversation.title)}\n`);
    for (const match of item.matches) {
      const context = match.kind === 'message' ? match.role ?? 'message' : `file ${match.artifactId ?? ''}`.trim();
      process.stdout.write(`  - ${terminalText(context)}: ${singleLine(match.snippet, 220)}\n`);
    }
  }
}

function renderConversationDetail(detail: PublicConversationDetail): void {
  process.stdout.write(`${terminalText(detail.title)}\n`);
  process.stdout.write(`${terminalText(detail.conversationId)}\n`);
  process.stdout.write(`${terminalText(detail.status)} · ${terminalText(detail.sourceKind)} · updated ${terminalText(detail.updatedAt)}`);
  if (detail.threadKey) process.stdout.write(` · thread ${terminalText(detail.threadKey)}`);
  process.stdout.write('\n');
  if (detail.transcript.compactedMessages > 0) {
    process.stdout.write(`${detail.transcript.compactedMessages} older messages compacted\n`);
  }
  process.stdout.write('\n');
  for (const message of detail.transcript.messages) {
    const label = message.role === 'user' ? 'You' : 'Rat';
    const metadata = [
      message.receivedAt,
      message.messageId ? `message ${message.messageId}` : undefined,
      message.replyToMessageId ? `reply to ${message.replyToMessageId}` : undefined,
    ].filter(Boolean).join(' · ');
    process.stdout.write(`${label}${metadata ? ` · ${terminalText(metadata)}` : ''}\n`);
    process.stdout.write(`${indent(message.content.trim() || '(empty)', '  ')}\n`);
    const reactions = message.reactions?.filter((reaction) => reaction.reacted).map((reaction) => reaction.emoji);
    if (reactions?.length) process.stdout.write(`  reactions ${terminalText(reactions.join(' '))}\n`);
    if (message.attachments?.length) {
      process.stdout.write(`  attachments ${terminalText(message.attachments.map((attachment) => attachment.id).join(', '))}\n`);
    }
    process.stdout.write('\n');
  }
  if (detail.transcript.nextToken) {
    process.stdout.write(`Next older page: --next-token ${terminalText(detail.transcript.nextToken)}\n`);
  }
}

type ConversationSource =
  | { kind: 'transcript-link'; url: string; label: string; role: 'user' | 'assistant'; messageId?: string }
  | { kind: 'attachment'; id: string; role: 'user' | 'assistant'; messageId?: string }
  | { kind: 'file'; id: string; path: string; mediaType: string; bytes: number };

interface ConversationSourceCollection {
  sources: ConversationSource[];
  pages: number;
  complete: boolean;
}

async function conversationSources(conversationId: string): Promise<ConversationSourceCollection> {
  const sources: ConversationSource[] = [];
  const seen = new Set<string>();
  const attachmentMessages = new Map<string, { role: 'user' | 'assistant'; messageId?: string }>();
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  let pages = 0;
  let complete = true;
  while (true) {
    const query = new URLSearchParams({ limit: '100' });
    if (nextToken) query.set('nextToken', nextToken);
    const detail = await api(
      `/v1/conversations/${conversationId}?${query}`,
      'GET',
    ) as PublicConversationDetail;
    pages += 1;
    for (const message of detail.transcript.messages) {
      for (const match of message.content.matchAll(/https?:\/\/[^\s<>()\]]+/g)) {
        const url = match[0].replace(/[.,;:!?]+$/, '');
        try {
          const parsed = new URL(url);
          if (!['https:', 'http:'].includes(parsed.protocol) || seen.has(`link:${url}`)) continue;
          seen.add(`link:${url}`);
          sources.push({
            kind: 'transcript-link',
            url,
            label: parsed.hostname,
            role: message.role,
            ...(message.messageId ? { messageId: message.messageId } : {}),
          });
        } catch {
          // Ignore malformed link-like text in transcript content.
        }
      }
      for (const attachment of message.attachments ?? []) {
        if (!attachmentMessages.has(attachment.id)) {
          attachmentMessages.set(attachment.id, {
            role: message.role,
            ...(message.messageId ? { messageId: message.messageId } : {}),
          });
        }
      }
    }
    const older = detail.transcript.nextToken;
    if (!older) break;
    if (pages >= 100 || tokens.has(older)) {
      complete = false;
      break;
    }
    tokens.add(older);
    nextToken = older;
  }
  const files = await artifactList({ kind: 'conversation', id: conversationId });
  for (const file of files) {
    if (seen.has(`file:${file.id}`)) continue;
    seen.add(`file:${file.id}`);
    attachmentMessages.delete(file.id);
    sources.push({
      kind: 'file',
      id: file.id,
      path: file.path,
      mediaType: file.mediaType,
      bytes: file.bytes,
    });
  }
  for (const [id, context] of attachmentMessages) {
    sources.push({ kind: 'attachment', id, ...context });
  }
  return { sources: sources.slice(0, 200), pages, complete };
}

function renderConversationSources(collection: ConversationSourceCollection): void {
  if (!collection.complete) {
    process.stderr.write('Warning: source collection stopped after 100 pages or a repeated cursor; results may be incomplete.\n');
  }
  if (collection.sources.length === 0) {
    process.stdout.write('No transcript links, attachments, or durable files found.\n');
    return;
  }
  for (const source of collection.sources) {
    if (source.kind === 'transcript-link') {
      process.stdout.write(`link\t${source.role}\t${terminalText(source.label)}\t${terminalText(source.url)}`);
      if (source.messageId) process.stdout.write(`\t${terminalText(source.messageId)}`);
      process.stdout.write('\n');
    } else if (source.kind === 'attachment') {
      process.stdout.write(`attachment\t${source.role}\t${terminalText(source.id)}`);
      if (source.messageId) process.stdout.write(`\t${terminalText(source.messageId)}`);
      process.stdout.write('\n');
    } else {
      process.stdout.write(`file\t${terminalText(source.path)}\t${terminalText(source.mediaType)}\t${source.bytes} bytes\t${terminalText(source.id)}\n`);
    }
  }
}

function publicConversationId(args: Arguments, index: number): string {
  const value = requiredPositional(args, index, 'public conversation ID');
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('public conversation ID must be the 64-character ID returned by conversations list or search');
  }
  return value;
}

function singleLine(value: string, maximum: number): string {
  const line = terminalText(value).replace(/\s+/g, ' ').trim();
  return line.length <= maximum ? line : `${line.slice(0, maximum - 1)}…`;
}

function indent(value: string, prefix: string): string {
  return terminalText(value).split('\n').map((line) => `${prefix}${line}`).join('\n');
}

/** Prevent provider- or agent-authored text from issuing terminal commands in human output. */
function terminalText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '�');
}

async function conversationAttachments(args: Arguments): Promise<ConversationAttachment[]> {
  const paths = repeated(args, 'attach') ?? [];
  if (paths.length > 6) throw new Error('--attach accepts at most 6 files');
  const result: ConversationAttachment[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = resolve(path);
    const metadata = await stat(absolute).catch((error: unknown) => {
      throw new Error(`could not read attachment ${path}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!metadata.isFile()) throw new Error(`attachment is not a regular file: ${path}`);
    if (metadata.size > 4 * 1024 * 1024) throw new Error(`attachment exceeds 4 MiB: ${path}`);
    totalBytes += metadata.size;
    if (totalBytes > 6 * 1024 * 1024) throw new Error('attachments exceed 6 MiB in total');
    const bytes = await readFile(absolute);
    result.push({
      name: basename(absolute),
      mediaType: mediaTypeForPath(absolute),
      base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return result;
}

function mediaTypeForPath(path: string): string {
  return ({
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.text': 'text/plain',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.zip': 'application/zip',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function local(args: Arguments): Promise<void> {
  const requestedAuthMode = args.values.get('codex-auth');
  const parsed = await requestFromArguments(args, true);
  const resolvedProfile = resolveAgentProfile(
    parsed.agent,
    new CapabilityProfileRegistry(createBuiltinCapabilityProfiles()),
  );
  const request: RunRequest = {
    ...parsed,
    ...(resolvedProfile.agent ? { agent: resolvedProfile.agent } : {}),
  };
  if (request.integrations) {
    throw new Error('local integration connections are not supported; use the remote MicroVM control API');
  }
  if (request.agent?.capabilities?.computerUse === 'browser') {
    throw new Error('local browser computer use is not supported; use a remote MicroVM or --no-browser');
  }
  const driverName = request.agent?.driver ?? 'mock';
  if (driverName === 'codex') process.env.CODEX_AUTH_MODE = localCodexAuthMode(requestedAuthMode);
  const timeout = (request.execution?.timeoutSeconds ?? 900) * 1_000;
  const explicitWorkspace = args.values.get('workspace');
  let workspace = explicitWorkspace ? resolve(explicitWorkspace) : process.cwd();
  let temporary: string | undefined;
  let loadedBedrockToken = false;
  const credentials = new CredentialBroker(
    new CachedSecretReader(new SecretsManagerClient(regionConfig())),
  );

  if (request.repository) {
    const root = resolve(process.env.WORKSPACE_ROOT ?? join(tmpdir(), 'agent-runtime'));
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(root, 'local-'));
    workspace = temporary;
    await prepareWorkspace(request.repository, workspace, credentials);
  }

  try {
    if (driverName === 'codex') await prepareArtifactDirectory(workspace);
    if (
      driverName === 'codex' &&
      codexAuthMode() === 'bedrock' &&
      !process.env.AWS_BEARER_TOKEN_BEDROCK
    ) {
      loadedBedrockToken = await loadCodexBedrockToken(credentials);
    }
    const result = await driverFor(driverName).execute(request, workspace, timeout);
    process.stdout.write(`${terminalText(result.fullText)}\n`);
    if (driverName === 'codex') {
      const paths = await localArtifactPaths(workspace);
      if (paths.length > 0) {
        process.stderr.write('\nFiles:\n');
        for (const path of paths) {
          process.stderr.write(`  ${terminalText(path)}\t${terminalText(resolve(workspace, '.rat-things/artifacts', path))}\n`);
        }
      }
    }
    if (args.flags.has('events')) {
      process.stderr.write(`\n--- events.jsonl ---\n${terminalText(result.events.toString('utf8'))}`);
    }
    if (args.flags.has('patch')) {
      const patch = await collectWorkspacePatch(workspace);
      if (patch) process.stderr.write(`\n--- workspace.patch ---\n${terminalText(patch.toString('utf8'))}\n`);
    }
  } finally {
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function submit(args: Arguments): Promise<void> {
  const request = await requestFromArguments(args, false);
  const headers: Record<string, string> = {};
  const key = args.values.get('idempotency-key');
  if (key) headers['idempotency-key'] = key;
  const record = await api('/v1/runs', 'POST', request, headers) as RunRecord;
  if (!args.flags.has('wait')) {
    print(record);
    return;
  }
  const current = await waitForRun(record, args);
  print(current);
  if (current.status === 'succeeded' && args.flags.has('output')) {
    await writeArtifact(current.runId, 'output');
  }
  if (current.status !== 'succeeded') process.exitCode = 1;
}

async function releaseThing(args: Arguments): Promise<void> {
  const file = args.values.get('file');
  if (file && args.positionals.length > 0) {
    throw new Error('thing-release accepts either THING_ID or --file THING.json, not both');
  }
  let created: unknown;
  let rawThingId = args.positionals[0];
  if (file) {
    created = await api('/v1/things', 'POST', await requiredJsonFile(args));
    rawThingId = thingIdFrom(created);
    process.stderr.write(`created Thing ${rawThingId}\n`);
  }
  if (!rawThingId) {
    throw new Error('provide a Thing ID or --file THING.json');
  }
  const thingId = encodeURIComponent(rawThingId);
  const explanation = await api(`/v1/things/${thingId}/explain`, 'GET') as {
    runnable?: unknown;
    diagnostics?: Array<{ status?: unknown; message?: unknown }>;
    thing?: unknown;
  };
  const errors = Array.isArray(explanation.diagnostics)
    ? explanation.diagnostics.filter((item) => item.status === 'error')
    : [];
  if (explanation.runnable !== true || errors.length > 0) {
    const detail = errors
      .map((item) => typeof item.message === 'string' ? item.message : 'unknown diagnostic')
      .join('; ');
    throw new Error(`Thing draft is not runnable${detail ? `: ${detail}` : ''}`);
  }
  const draft = thingDraftIdentity(explanation.thing);
  const idempotencyKey = args.values.get('idempotency-key') ??
    `release:${rawThingId}:${draft.revision}:${draft.specHash.slice(0, 16)}`;
  process.stderr.write(`testing Thing revision ${draft.revision} (${draft.specHash.slice(0, 12)})\n`);
  const accepted = await api(
    `/v1/things/${thingId}/test`,
    'POST',
    {},
    { 'idempotency-key': idempotencyKey },
  ) as RunRecord;
  const testRun = await waitForRun(accepted, args);
  if (testRun.status !== 'succeeded') {
    print({ version: '1', released: false, ...(created ? { created } : {}), testRun });
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`publishing tested Thing revision ${draft.revision}\n`);
  const thing = await api(`/v1/things/${thingId}/publish`, 'POST', {
    version: '1',
    expectedDraftRevision: draft.revision,
    expectedSpecHash: draft.specHash,
    testRunId: testRun.runId,
  });
  print({ version: '1', released: true, ...(created ? { created } : {}), testRun, thing });
}

function thingIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('runtime returned an invalid Thing');
  const thingId = (value as { thingId?: unknown }).thingId;
  if (typeof thingId !== 'string' || !thingId) throw new Error('runtime returned no Thing ID');
  return thingId;
}

async function waitForRun(record: RunRecord, args: Arguments): Promise<RunRecord> {
  const interval = positiveNumber(args.values.get('poll-seconds') ?? '2', 'poll-seconds');
  const waitSeconds = positiveNumber(args.values.get('wait-timeout') ?? '2400', 'wait-timeout');
  const deadline = Date.now() + waitSeconds * 1_000;
  let current = record;
  let previousStatus: string | undefined;
  while (!isTerminal(current.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${waitSeconds}s waiting for Run ${record.runId}`);
    }
    if (current.status !== previousStatus) {
      process.stderr.write(`run ${current.runId}: ${current.status}\n`);
      previousStatus = current.status;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
    current = await api(`/v1/runs/${record.runId}`, 'GET') as RunRecord;
  }
  if (current.status !== previousStatus) process.stderr.write(`run ${current.runId}: ${current.status}\n`);
  return current;
}

async function watch(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    flags: ['follow', 'json', 'raw'],
    values: ['after', 'poll-seconds'],
  });
  validatePositionals(args, 1, 1, 'watch RUN_ID');
  if (args.flags.has('json') && args.flags.has('raw')) {
    throw new Error('--json cannot be combined with --raw');
  }
  const runId = requiredPositional(args, 0, 'run ID');
  let after = nonNegativeNumber(args.values.get('after') ?? '0', 'after');
  const interval = positiveNumber(args.values.get('poll-seconds') ?? '1', 'poll-seconds');
  const seenPending = new Set<string>();
  let previousRunStatus: string | undefined;
  let warnedGap: string | undefined;
  while (true) {
    const requestedAfter = after;
    const query = new URLSearchParams({ after: String(after), limit: '100' });
    const snapshot = await api(
      `/v1/runs/${encodeURIComponent(runId)}/events?${query}`,
      'GET',
    ) as PublicAgentRuntimeSnapshot;
    if (requestedAfter < snapshot.oldestSequence - 1) {
      const gap = `${requestedAfter + 1}-${snapshot.oldestSequence - 1}`;
      if (gap !== warnedGap) {
        process.stderr.write(
          `Warning: live activity ${gap} is no longer in the bounded ring; use the terminal events JSONL artifact for the durable record.\n`,
        );
        warnedGap = gap;
      }
    }
    if (args.flags.has('json')) {
      if (args.flags.has('follow')) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      else print(snapshot);
    }
    else if (args.flags.has('raw')) {
      for (const event of snapshot.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      for (const pending of snapshot.pendingRequests) {
        process.stderr.write(`agent request pending: ${JSON.stringify(pending)}\n`);
      }
    } else {
      for (const event of snapshot.events) renderActivity(event);
      for (const pending of snapshot.pendingRequests) {
        if (seenPending.has(pending.requestId)) continue;
        seenPending.add(pending.requestId);
        renderPendingRequest(runId, pending);
      }
    }
    const last = snapshot.events.at(-1);
    if (last) after = last.sequence;
    if (!args.flags.has('follow')) return;
    const run = await api(`/v1/runs/${encodeURIComponent(runId)}`, 'GET') as RunRecord;
    if (!args.flags.has('json') && run.status !== previousRunStatus) {
      process.stderr.write(`Run ${run.runId}: ${run.status}\n`);
      previousRunStatus = run.status;
    }
    if (isTerminal(run.status)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
  }
}

function renderActivity(event: PublicAgentActivity): void {
  const status = ({
    started: '▶',
    updated: '·',
    completed: '✓',
    failed: '!',
    info: '·',
  } as const)[event.status];
  const time = Number.isNaN(Date.parse(event.occurredAt))
    ? event.occurredAt
    : new Date(event.occurredAt).toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(`${terminalText(time)}  ${status} ${terminalText(event.title)}`);
  if (event.detail) process.stdout.write(` — ${terminalText(event.detail)}`);
  process.stdout.write('\n');
}

function renderPendingRequest(runId: string, pending: PublicPendingAgentRequest): void {
  process.stderr.write(`\nInput needed · ${terminalText(pending.title)}\n`);
  if (pending.detail) process.stderr.write(`${terminalText(pending.detail)}\n`);
  for (const question of pending.questions ?? []) {
    process.stderr.write(`  ${terminalText(question.id)}: ${terminalText(question.question)}\n`);
    for (const option of question.options ?? []) {
      process.stderr.write(`    - ${terminalText(option.label)}`);
      if (option.description) process.stderr.write(` — ${terminalText(option.description)}`);
      process.stderr.write('\n');
    }
  }
  if (pending.questions?.length) {
    const answers = pending.questions.map((question) => question.isSecret
      ? `--answer-stdin ${question.id}`
      : `--answer ${question.id}=VALUE`).join(' ');
    process.stderr.write(`Respond: rat-things respond ${terminalText(runId)} ${terminalText(pending.requestId)} ${terminalText(answers)}\n\n`);
  } else {
    process.stderr.write(`Respond: rat-things respond ${terminalText(runId)} ${terminalText(pending.requestId)} --result JSON\n\n`);
  }
}

async function steer(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const prompt = args.values.get('prompt') ?? args.positionals.slice(1).join(' ');
  if (!prompt.trim()) throw new Error('steer prompt is required');
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/steer`,
    'POST',
    { prompt },
  ));
}

async function respond(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    values: ['result'],
    multiple: ['answer', 'answer-stdin'],
  });
  validatePositionals(args, 2, 2, 'respond RUN_ID REQUEST_ID');
  const runId = requiredPositional(args, 0, 'run ID');
  const requestId = requiredPositional(args, 1, 'server request ID');
  const raw = args.values.get('result');
  const answers = repeated(args, 'answer') ?? [];
  const stdinQuestions = repeated(args, 'answer-stdin') ?? [];
  if (raw !== undefined && (answers.length > 0 || stdinQuestions.length > 0)) {
    throw new Error('--result cannot be combined with --answer or --answer-stdin');
  }
  if (raw === undefined && answers.length === 0 && stdinQuestions.length === 0) {
    throw new Error('provide --result JSON, --answer QUESTION=VALUE, or --answer-stdin QUESTION');
  }
  let result: unknown;
  if (raw !== undefined) {
    try {
      result = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('--result must be valid JSON');
    }
  } else {
    const structured: Record<string, { answers: string[] }> = {};
    for (const answer of answers) {
      const separator = answer.indexOf('=');
      if (separator < 1 || separator === answer.length - 1) {
        throw new Error('--answer must use QUESTION=VALUE');
      }
      const question = answer.slice(0, separator);
      const value = answer.slice(separator + 1).trim();
      if (!value) throw new Error('--answer value cannot be empty');
      if (structured[question]) throw new Error(`question ${JSON.stringify(question)} was answered more than once`);
      structured[question] = { answers: [value] };
    }
    const stdinAnswers = await readSecretAnswers(stdinQuestions);
    for (const [question, value] of stdinAnswers) {
      if (structured[question]) throw new Error(`question ${JSON.stringify(question)} was answered more than once`);
      structured[question] = { answers: [value] };
    }
    result = { answers: structured };
  }
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/requests/${encodeURIComponent(requestId)}/respond`,
    'POST',
    { result },
  ));
}

async function readSecretAnswers(questionIds: string[]): Promise<Map<string, string>> {
  const unique = new Set<string>();
  for (const questionId of questionIds) {
    if (!questionId.trim()) throw new Error('--answer-stdin question ID cannot be empty');
    if (unique.has(questionId)) {
      throw new Error(`question ${JSON.stringify(questionId)} was requested from stdin more than once`);
    }
    unique.add(questionId);
  }
  if (questionIds.length === 0) return new Map();
  const values = process.stdin.isTTY
    ? await readHiddenTtyAnswers(questionIds)
    : await readPipedAnswers(questionIds);
  return new Map(questionIds.map((questionId, index) => [questionId, values[index] as string]));
}

async function readPipedAnswers(questionIds: string[]): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== questionIds.length) {
    throw new Error(
      `--answer-stdin expected ${questionIds.length} line${questionIds.length === 1 ? '' : 's'} on stdin but received ${lines.length}`,
    );
  }
  return lines.map((line, index) => {
    if (!line) throw new Error(`stdin answer for ${questionIds[index]} cannot be empty`);
    return line;
  });
}

async function readHiddenTtyAnswers(questionIds: string[]): Promise<string[]> {
  const values: string[] = [];
  for (const questionId of questionIds) values.push(await readHiddenTtyAnswer(questionId));
  return values;
}

async function readHiddenTtyAnswer(questionId: string): Promise<string> {
  const input = process.stdin;
  const previousRaw = input.isRaw;
  process.stderr.write(`Secret answer for ${questionId}: `);
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolvePromise, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    };
    const finish = () => {
      cleanup();
      process.stderr.write('\n');
      if (!value) reject(new Error(`secret answer for ${questionId} cannot be empty`));
      else resolvePromise(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('secret answer input cancelled'));
          return;
        }
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}

async function computerCommand(args: Arguments): Promise<void> {
  const subcommand = args.positionals[0];
  const subcommands = [
    'open', 'watch', 'screenshot', 'status', 'takeover', 'release', 'handback', 'act', 'teach',
    'navigate', 'click', 'type', 'press', 'select', 'scroll', 'wait', 'back', 'help',
  ];
  if (!subcommand) {
    computerHelp();
    return;
  }
  if (!subcommands.includes(subcommand)) {
    if (args.positionals.length > 1) {
      throw new Error(`unknown computer subcommand ${JSON.stringify(subcommand)}; run rat-things computer --help`);
    }
    validateCommandOptions(args, { values: ['screenshot'] });
    validatePositionals(args, 1, 1, 'computer RUN_ID');
    await computer(args);
    return;
  }
  const nested = withPositionals(args, args.positionals.slice(1));
  switch (subcommand) {
    case 'open':
      validateCommandOptions(nested, { flags: ['no-wait'], values: ['port', 'run', 'thread'] });
      validatePositionals(nested, 0, 1, 'computer open [RUN_ID]');
      await openConsole(nested);
      return;
    case 'watch':
    case 'screenshot':
    case 'status':
      validateCommandOptions(nested, { values: ['screenshot'] });
      validatePositionals(nested, 1, 1, `computer ${subcommand} RUN_ID`);
      await computer(nested);
      return;
    case 'takeover':
      validateCommandOptions(nested, {});
      validatePositionals(nested, 1, 1, 'computer takeover RUN_ID');
      await setComputerControl(nested, 'human');
      return;
    case 'release':
    case 'handback':
      validateCommandOptions(nested, {});
      validatePositionals(nested, 1, 1, `computer ${subcommand} RUN_ID`);
      await setComputerControl(nested, 'agent');
      return;
    case 'act':
      validateCommandOptions(nested, { values: ['file'] });
      validatePositionals(nested, 1, 1, 'computer act RUN_ID --file ACTION.json');
      await computerAct(nested);
      return;
    case 'navigate':
    case 'click':
    case 'type':
    case 'press':
    case 'select':
    case 'scroll':
    case 'wait':
    case 'back':
      await computerFriendlyAction(nested, subcommand);
      return;
    case 'teach': {
      const action = nested.positionals[0];
      const teachArgs = withPositionals(nested, nested.positionals.slice(1));
      if (action === 'start') {
        validateCommandOptions(teachArgs, { values: ['goal', 'name'] });
        validatePositionals(teachArgs, 1, 1, 'computer teach start RUN_ID --name NAME');
        await teachStart(teachArgs);
      } else if (action === 'stop' || action === 'discard') {
        validateCommandOptions(teachArgs, {});
        validatePositionals(teachArgs, 1, 1, `computer teach ${action} RUN_ID`);
        await teachStop(teachArgs, action === 'discard');
      }
      else throw new Error('computer teach requires start, stop, or discard');
      return;
    }
    default:
      computerHelp();
  }
}

function withPositionals(args: Arguments, positionals: string[]): Arguments {
  return { ...args, positionals };
}

async function openConsole(args: Arguments): Promise<void> {
  const base = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  if (!base) throw new Error('RAT_THINGS_API_URL is required to open the signed console');
  const port = Number(args.values.get('port') ?? '4174');
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('--port must be an integer from 1024 through 65535');
  }
  const selector = new URLSearchParams();
  const runId = args.values.get('run') ?? args.positionals[0];
  const thread = args.values.get('thread');
  if (runId && thread) throw new Error('choose either --run or --thread when opening the console');
  if (runId) selector.set('run', runId);
  if (thread) selector.set('thread', thread);

  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledServer = join(cliDirectory, 'console-server.mjs');
  const sourceRoot = dirname(cliDirectory);
  const bundled = existsSync(bundledServer);
  const executable = bundled ? process.execPath : join(sourceRoot, 'node_modules', '.bin', 'tsx');
  const serverArgs = bundled ? [bundledServer] : [join(sourceRoot, 'scripts', 'console-server.ts')];
  if (!existsSync(executable) || !existsSync(serverArgs[0]!)) {
    throw new Error('the console runtime is missing; run npm run build from a Rat Things checkout');
  }
  const consoleRoot = bundled ? join(cliDirectory, 'console') : join(sourceRoot, 'console');
  const child = spawn(executable, serverArgs, {
    env: {
      ...process.env,
      RAT_THINGS_API_URL: base,
      RAT_THINGS_CONSOLE_PORT: String(port),
      RAT_THINGS_CONSOLE_ROOT: consoleRoot,
    },
    stdio: args.flags.has('no-wait') ? 'ignore' : 'inherit',
    detached: args.flags.has('no-wait'),
  });
  const url = `http://127.0.0.1:${port}/${selector.size ? `?${selector.toString()}` : ''}`;
  try {
    await waitForLocalConsole(url, child);
    launchBrowser(url);
    process.stdout.write(`Rat Things console: ${url}\n`);
    if (args.flags.has('no-wait')) {
      child.unref();
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 || code === null
        ? resolvePromise()
        : reject(new Error(`console server exited with code ${code}`)));
    });
  } catch (error) {
    if (!child.killed) child.kill('SIGTERM');
    throw error;
  }
}

async function waitForLocalConsole(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`console server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Loopback server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('console server did not become ready within 6 seconds');
}

function launchBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? ['open', [url]] as const
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] as const
      : ['xdg-open', [url]] as const;
  const browser = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  browser.unref();
}

function computerHelp(): void {
  process.stdout.write(`Rat Things live computer\n\n`);
  process.stdout.write(`  rat-things computer open [RUN_ID|--run RUN_ID|--thread NAME] [--port 4174]\n`);
  process.stdout.write(`  rat-things computer watch RUN_ID [--screenshot screen.jpg]\n`);
  process.stdout.write(`  rat-things computer takeover RUN_ID\n`);
  process.stdout.write(`  rat-things computer release RUN_ID\n`);
  process.stdout.write(`  rat-things computer navigate RUN_ID URL\n`);
  process.stdout.write(`  rat-things computer click RUN_ID (--ref REF | --x X --y Y)\n`);
  process.stdout.write(`  rat-things computer type RUN_ID [--ref REF] [--clear] [--submit] TEXT\n`);
  process.stdout.write(`  rat-things computer press RUN_ID KEY\n`);
  process.stdout.write(`  rat-things computer select RUN_ID REF VALUE\n`);
  process.stdout.write(`  rat-things computer scroll RUN_ID --delta-y PIXELS [--delta-x PIXELS]\n`);
  process.stdout.write(`  rat-things computer wait RUN_ID MILLISECONDS\n`);
  process.stdout.write(`  rat-things computer back RUN_ID\n`);
  process.stdout.write(`  rat-things computer act RUN_ID --file ACTION.json\n`);
  process.stdout.write(`  rat-things computer teach start RUN_ID --name NAME [--goal TEXT]\n`);
  process.stdout.write(`  rat-things computer teach stop|discard RUN_ID\n`);
}

function chatHelp(): void {
  process.stdout.write(`Rat Things chat\n\n`);
  process.stdout.write(`  rat-things chat [--thread NAME|--new] [--attach PATH]... [--reply-to MESSAGE_ID]\n`);
  process.stdout.write(`    [--delivery interrupt|defer] [--driver DRIVER] [--profile NAME]\n`);
  process.stdout.write(`    [--network|--no-network] [--browser|--no-browser] [--json] [--no-wait]\n`);
  process.stdout.write(`    [--idempotency-key KEY] [--poll-seconds N] [--wait-timeout N] "PROMPT"\n\n`);
  process.stdout.write(`Repeat --attach up to six times. Use -- before prompt text that starts with a dash.\n`);
  process.stdout.write(`The public conversation ID is not a thread key; use the thread key displayed by list/show.\n`);
}

function runInteractionHelp(): void {
  process.stdout.write(`Rat Things live Run interaction\n\n`);
  process.stdout.write(`  rat-things watch RUN_ID [--follow] [--after SEQUENCE] [--poll-seconds N]\n`);
  process.stdout.write(`    [--json|--raw]\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --result JSON\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --answer QUESTION=VALUE ...\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --answer-stdin SECRET_QUESTION ...\n\n`);
  process.stdout.write(`Readable watch output is the default. One --json poll is a JSON document;\n`);
  process.stdout.write(`--follow --json and --raw are JSONL. Secret stdin is hidden on a terminal.\n`);
}

function conversationHelp(): void {
  process.stdout.write(`Rat Things conversations\n\n`);
  process.stdout.write(`  rat-things conversations list [--visibility visible|hidden|all] [--limit N] [--next-token TOKEN] [--json]\n`);
  process.stdout.write(`  rat-things conversations search QUERY [--limit N] [--json]\n`);
  process.stdout.write(`  rat-things conversation show PUBLIC_ID [--limit N] [--next-token TOKEN] [--json]\n`);
  process.stdout.write(`  rat-things conversation sources PUBLIC_ID [--json]\n`);
  process.stdout.write(`  rat-things conversation pin|unpin|hide|unhide|read|unread PUBLIC_ID\n`);
  process.stdout.write(`  rat-things conversation react|unreact PUBLIC_ID MESSAGE_ID 👍|❤️|🎉|👀\n\n`);
  process.stdout.write(`PUBLIC_ID is the opaque 64-character ID returned by list or search.\n`);
  process.stdout.write(`Use the displayed thread key with rat-things chat --thread NAME to continue an API conversation.\n`);
}

async function computer(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const snapshot = await api(
    `/v1/runs/${encodeURIComponent(runId)}/computer`,
    'GET',
  );
  if (!isObject(snapshot) || typeof snapshot.imageDataUrl !== 'string') {
    throw new Error('computer response did not contain a screen image');
  }
  const screenshot = args.values.get('screenshot');
  if (screenshot) {
    const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(snapshot.imageDataUrl);
    if (!match?.[2]) throw new Error('computer response contained an invalid screen image');
    await writeFile(resolve(screenshot), Buffer.from(match[2], 'base64'), { mode: 0o600 });
  }
  const { imageDataUrl: _imageDataUrl, ...summary } = snapshot;
  print({
    ...summary,
    screen: screenshot ? { writtenTo: resolve(screenshot) } : { available: true },
  });
}

async function setComputerControl(args: Arguments, control: 'human' | 'agent'): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/computer/takeover`,
    'POST',
    { control },
  ));
}

async function computerAct(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const action = await requiredJsonFile(args);
  await sendComputerAction(runId, action);
}

async function computerFriendlyAction(args: Arguments, type: string): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  let action: Record<string, unknown>;
  switch (type) {
    case 'navigate':
      validateCommandOptions(args, {});
      validatePositionals(args, 2, 2, 'computer navigate RUN_ID URL');
      action = { type, url: requiredPositional(args, 1, 'URL') };
      break;
    case 'click': {
      validateCommandOptions(args, { values: ['ref', 'x', 'y'] });
      validatePositionals(args, 1, 1, 'computer click RUN_ID (--ref REF | --x X --y Y)');
      const ref = args.values.get('ref');
      const rawX = args.values.get('x');
      const rawY = args.values.get('y');
      if (ref && (rawX !== undefined || rawY !== undefined)) {
        throw new Error('computer click accepts either --ref or --x with --y');
      }
      if (!ref && (rawX === undefined || rawY === undefined)) {
        throw new Error('computer click requires --ref REF or both --x X and --y Y');
      }
      action = ref
        ? { type, ref }
        : { type, x: boundedCliNumber(rawX as string, 'x', 0, 1_280), y: boundedCliNumber(rawY as string, 'y', 0, 720) };
      break;
    }
    case 'type': {
      validateCommandOptions(args, { flags: ['clear', 'submit'], values: ['ref', 'text'] });
      if (args.values.has('text')) validatePositionals(args, 1, 1, 'computer type RUN_ID --text TEXT');
      else if (args.positionals.length < 2) throw new Error('computer type requires text');
      const text = args.values.get('text') ?? args.positionals.slice(1).join(' ');
      if (!text) throw new Error('computer type requires text');
      action = {
        type,
        text,
        ...(args.values.has('ref') ? { ref: args.values.get('ref') } : {}),
        ...(args.flags.has('clear') ? { clear: true } : {}),
        ...(args.flags.has('submit') ? { submit: true } : {}),
      };
      break;
    }
    case 'press':
      validateCommandOptions(args, { values: ['key'] });
      validatePositionals(args, args.values.has('key') ? 1 : 2, args.values.has('key') ? 1 : 2, 'computer press RUN_ID KEY');
      action = { type, key: args.values.get('key') ?? requiredPositional(args, 1, 'key') };
      break;
    case 'select':
      validateCommandOptions(args, { values: ['ref', 'value'] });
      if (args.values.has('ref') !== args.values.has('value')) {
        throw new Error('computer select requires both --ref and --value when either option is used');
      }
      validatePositionals(args, args.values.has('ref') ? 1 : 3, args.values.has('ref') ? 1 : 3, 'computer select RUN_ID REF VALUE');
      action = {
        type,
        ref: args.values.get('ref') ?? requiredPositional(args, 1, 'element reference'),
        value: args.values.get('value') ?? requiredPositional(args, 2, 'selected value'),
      };
      break;
    case 'scroll':
      validateCommandOptions(args, { values: ['delta-x', 'delta-y'] });
      validatePositionals(args, args.values.has('delta-y') ? 1 : 2, args.values.has('delta-y') ? 1 : 2, 'computer scroll RUN_ID --delta-y PIXELS');
      action = {
        type,
        deltaY: boundedCliNumber(
          args.values.get('delta-y') ?? requiredPositional(args, 1, 'vertical scroll delta'),
          'delta-y',
          -5_000,
          5_000,
        ),
        ...(args.values.has('delta-x')
          ? { deltaX: boundedCliNumber(args.values.get('delta-x') as string, 'delta-x', -5_000, 5_000) }
          : {}),
      };
      break;
    case 'wait':
      validateCommandOptions(args, { values: ['milliseconds'] });
      validatePositionals(args, args.values.has('milliseconds') ? 1 : 2, args.values.has('milliseconds') ? 1 : 2, 'computer wait RUN_ID MILLISECONDS');
      action = {
        type,
        milliseconds: boundedCliNumber(
          args.values.get('milliseconds') ?? requiredPositional(args, 1, 'milliseconds'),
          'milliseconds',
          0,
          10_000,
          true,
        ),
      };
      break;
    case 'back':
      validateCommandOptions(args, {});
      validatePositionals(args, 1, 1, 'computer back RUN_ID');
      action = { type };
      break;
    default:
      throw new Error(`unsupported computer action ${type}`);
  }
  await sendComputerAction(runId, action);
}

async function sendComputerAction(runId: string, action: unknown): Promise<void> {
  const snapshot = await api(
    `/v1/runs/${encodeURIComponent(runId)}/computer/action`,
    'POST',
    { action },
  );
  if (isObject(snapshot)) {
    const { imageDataUrl: _imageDataUrl, ...summary } = snapshot;
    print(summary);
    return;
  }
  print(snapshot);
}

function boundedCliNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw new Error(`--${label} must be ${integer ? 'an integer' : 'a number'} from ${minimum} through ${maximum}`);
  }
  return parsed;
}

async function teachStart(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const name = args.values.get('name');
  if (!name?.trim()) throw new Error('--name is required');
  const snapshot = await api(
    `/v1/runs/${encodeURIComponent(runId)}/computer/teach`,
    'POST',
    { action: 'start', name, ...(args.values.has('goal') ? { goal: args.values.get('goal') } : {}) },
  );
  if (isObject(snapshot)) {
    const { imageDataUrl: _imageDataUrl, ...summary } = snapshot;
    print(summary);
    return;
  }
  print(snapshot);
}

async function teachStop(args: Arguments, discard: boolean): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/computer/teach`,
    'POST',
    { action: 'stop', discard },
  ));
}

async function requiredJsonFile(args: Arguments): Promise<unknown> {
  const path = args.values.get('file');
  if (!path) throw new Error('--file JSON is required');
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function connect(args: Arguments): Promise<void> {
  const pluginId = requiredPositional(args, 0, 'plugin ID');
  const plugin = await installedIntegrationPlugin(pluginId);
  const requestedScheme = args.values.get('auth-scheme');
  const authentication = requestedScheme
    ? plugin.authentication.find((candidate) => candidate.scheme === requestedScheme)
    : plugin.authentication.length === 1
      ? plugin.authentication[0]
      : undefined;
  if (!authentication) {
    const choices = plugin.authentication.map((candidate) => candidate.scheme).join(', ');
    throw new Error(requestedScheme
      ? `integration plugin ${pluginId} does not support ${requestedScheme}; choose ${choices}`
      : `--auth-scheme is required; choose ${choices}`);
  }
  const credential = await credentialFile(args, authentication.fields);
  const access = args.values.get('access') ?? 'read-only';
  if (!['read-only', 'read-write', 'full'].includes(access)) {
    throw new Error('--access must be read-only, read-write, or full');
  }
  print(await api('/v1/integrations/connections', 'POST', {
    version: '1',
    pluginId,
    ...(args.values.get('alias') ? { alias: args.values.get('alias') } : {}),
    authScheme: authentication.scheme as IntegrationAuthScheme,
    credential,
    grant: { version: '1', preset: access },
  }));
}

async function installedIntegrationPlugin(pluginId: string): Promise<IntegrationPluginManifest> {
  const catalog = await api('/v1/integrations/plugins', 'GET') as { plugins?: unknown };
  if (!Array.isArray(catalog.plugins)) throw new Error('runtime returned an invalid integration catalog');
  const plugin = (catalog.plugins as IntegrationPluginManifest[]).find(
    (candidate) => candidate.id === pluginId,
  );
  if (!plugin) throw new Error(`integration plugin ${pluginId} is not installed`);
  if (!Array.isArray(plugin.authentication) || plugin.authentication.length === 0) {
    throw new Error(`integration plugin ${pluginId} has no authentication methods`);
  }
  return plugin;
}

async function rotateCredential(args: Arguments): Promise<void> {
  const selector = requiredPositional(args, 0, 'connection ID or alias');
  const listed = await api('/v1/integrations/connections', 'GET') as { connections?: unknown };
  if (!Array.isArray(listed.connections)) throw new Error('runtime returned an invalid connection list');
  const record = (listed.connections as Array<{ connection?: unknown }>).find((candidate) => {
    const connection = candidate.connection;
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return false;
    const value = connection as Record<string, unknown>;
    return value.connectionId === selector || value.alias === selector;
  });
  if (!record?.connection || typeof record.connection !== 'object' || Array.isArray(record.connection)) {
    throw new Error(`integration connection ${selector} was not found`);
  }
  const connection = record.connection as Record<string, unknown>;
  if (typeof connection.pluginId !== 'string') throw new Error('runtime returned an invalid connection plugin');
  const authorization = connection.authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new Error('runtime returned an invalid connection authorization');
  }
  const scheme = (authorization as Record<string, unknown>).scheme;
  const plugin = await installedIntegrationPlugin(connection.pluginId);
  const authentication = plugin.authentication.find((candidate) => candidate.scheme === scheme);
  if (!authentication) throw new Error('connection authentication method is no longer installed');
  const credential = await credentialFile(args, authentication.fields);
  print(await api(
    `/v1/integrations/connections/${encodeURIComponent(selector)}/credential`,
    'POST',
    { version: '1', credential },
  ));
}

async function credentialFile(
  args: Arguments,
  fields: IntegrationPluginManifest['authentication'][number]['fields'],
): Promise<Record<string, string>> {
  const path = args.values.get('credential-file');
  if (!path) {
    const expected = fields.map((field) => field.key).join(', ');
    throw new Error(`--credential-file JSON is required with fields: ${expected || '(none)'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read credential JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential file must contain one JSON object');
  }
  const result: Record<string, string> = {};
  const expected = new Set(fields.map((field) => field.key));
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field.key];
    if (typeof value !== 'string' || !value) {
      throw new Error(`credential file requires non-empty string field ${field.key}`);
    }
    result[field.key] = value;
  }
  for (const key of Object.keys(parsed)) {
    if (!expected.has(key)) throw new Error(`credential field ${key} is not used by ${args.positionals[0]}`);
  }
  return result;
}

async function writeArtifact(runId: string, name: string): Promise<void> {
  if (!['input', 'output', 'events', 'patch'].includes(name)) {
    throw new Error('artifact name must be input, output, events, or patch');
  }
  const descriptor = await api(`/v1/runs/${runId}/artifacts/${name}`, 'GET') as {
    url?: unknown;
    primaryPath?: string;
    paths?: string[];
  };
  if (typeof descriptor.url !== 'string') throw new Error('runtime returned no artifact URL');
  const response = await fetchSharedResource(
    descriptor.url,
    30_000,
    publicationAssetPath(descriptor),
  );
  if (!response.ok) throw new Error(`artifact download returned HTTP ${response.status}`);
  process.stdout.write(terminalText(await response.text()));
  if (name === 'output') process.stdout.write('\n');
}

async function listFiles(args: Arguments): Promise<void> {
  const scope = artifactScope(args);
  const files = await artifactList(scope);
  if (args.flags.has('json')) {
    print({ scope, files });
    return;
  }
  if (files.length === 0) {
    process.stdout.write('No files.\n');
    return;
  }
  for (const file of files) {
    process.stdout.write(`${terminalText(file.path)}\t${terminalText(file.mediaType)}\t${file.bytes}\t${terminalText(file.id)}\n`);
  }
}

async function file(args: Arguments): Promise<void> {
  const name = requiredPositional(args, 0, 'file name or ID');
  const scope = artifactScope(args);
  const files = await artifactList(scope);
  const matches = files.filter((candidate) => (
    candidate.id === name ||
    candidate.path === name ||
    candidate.path.split('/').at(-1) === name
  ));
  if (matches.length === 0) throw new Error(`file ${JSON.stringify(name)} was not found`);
  if (matches.length > 1) {
    throw new Error(`file name ${JSON.stringify(name)} is ambiguous; use its path or ID`);
  }
  const descriptor = await artifactDescriptorFor(scope, matches[0]!.id);
  const destination = args.values.get('download');
  if (!destination) {
    if (args.flags.has('json')) print(descriptor);
    else process.stdout.write(`${terminalText(descriptor.url)}\n`);
    return;
  }
  const response = await fetchSharedResource(
    descriptor.url,
    120_000,
    publicationAssetPath(descriptor),
  );
  if (!response.ok) throw new Error(`file download returned HTTP ${response.status}`);
  const target = resolve(destination);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  process.stdout.write(`${terminalText(target)}\n`);
}

async function publish(args: Arguments): Promise<void> {
  const kind = requiredPositional(args, 0, 'publication kind');
  if (!['file', 'site', 'video'].includes(kind)) {
    throw new Error('publication kind must be file, site, or video');
  }
  const source = requiredPositional(args, 1, kind === 'site' ? 'site root' : 'file name');
  const title = args.values.get('title');
  const spec = kind === 'site'
    ? {
        version: '1',
        kind,
        ...(source === '.' ? {} : { root: source }),
        ...(args.values.get('entrypoint') ? { entrypoint: args.values.get('entrypoint') } : {}),
        ...(title ? { title } : {}),
      }
    : kind === 'video'
      ? {
          version: '1',
          kind,
          path: source,
          ...(args.values.get('poster') ? { poster: args.values.get('poster') } : {}),
          ...(title ? { title } : {}),
        }
      : { version: '1', kind, path: source, ...(title ? { title } : {}) };
  const scope = artifactScope(args);
  const descriptor = await api(`${artifactBasePath(scope)}/publications`, 'POST', spec);
  if (args.flags.has('json')) print(descriptor);
  else process.stdout.write(`${terminalText((descriptor as { url: string }).url)}\n`);
}

function publicationAssetPath(descriptor: {
  primaryPath?: string;
  paths?: string[];
}): string | undefined {
  return descriptor.primaryPath ?? descriptor.paths?.find((path) => path !== 'index.html');
}

type ArtifactScope = { kind: 'run' | 'conversation'; id: string };

function artifactScope(args: Arguments): ArtifactScope {
  const runId = args.values.get('run');
  const thread = args.values.get('thread') ?? args.values.get('conversation');
  if (runId && thread) throw new Error('--run cannot be combined with --thread or --conversation');
  if (runId) return { kind: 'run', id: runId };
  const conversationId = thread ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationId)) {
    throw new Error('thread must be 1-128 safe ASCII characters');
  }
  return { kind: 'conversation', id: conversationId };
}

async function artifactList(scope: ArtifactScope): Promise<ArtifactMetadata[]> {
  const result = await api(`${artifactBasePath(scope)}/artifacts`, 'GET') as { files?: unknown };
  if (!Array.isArray(result.files)) throw new Error('runtime returned an invalid file list');
  return result.files as ArtifactMetadata[];
}

async function artifactDescriptorFor(
  scope: ArtifactScope,
  id: string,
): Promise<ArtifactDescriptor> {
  const result = await api(
    `${artifactBasePath(scope)}/artifacts/${encodeURIComponent(id)}`,
    'GET',
  );
  if (!result || typeof result !== 'object' || typeof (result as { url?: unknown }).url !== 'string') {
    throw new Error('runtime returned no file URL');
  }
  return result as ArtifactDescriptor;
}

function artifactBasePath(scope: ArtifactScope): string {
  return scope.kind === 'run'
    ? `/v1/runs/${encodeURIComponent(scope.id)}`
    : `/v1/conversations/${encodeURIComponent(scope.id)}`;
}

async function requestFromArguments(args: Arguments, localMode: boolean): Promise<RunRequest> {
  const file = args.values.get('file');
  if (file) return parseRunRequest(JSON.parse(await readFile(resolve(file), 'utf8')) as unknown, validationOptions());
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT or --file REQUEST.json');
  const request: Record<string, unknown> = {
    version: '1',
    prompt,
    agent: agentFromArguments(args, localMode),
    ...withIntegrations(args),
    execution: compact({
      backend: args.values.get('backend'),
      timeoutSeconds: args.values.has('timeout')
        ? positiveNumber(args.values.get('timeout') as string, 'timeout')
        : undefined,
    }),
  };
  const repositoryUrl = args.values.get('repo');
  if (repositoryUrl) {
    request.repository = compact({
      provider: args.values.get('provider') ?? inferProvider(repositoryUrl),
      url: repositoryUrl,
      ref: args.values.get('ref'),
      baseRef: args.values.get('base-ref'),
      credentialSecretArn: args.values.get('credential-secret-arn'),
    });
  }
  return parseRunRequest(request, validationOptions());
}

async function conversationRequestFromArguments(args: Arguments): Promise<unknown> {
  const file = args.values.get('file');
  if (file) return JSON.parse(await readFile(resolve(file), 'utf8')) as unknown;
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT, positional prompt text, or --file REQUEST.json');
  return {
    version: '1',
    prompt,
    agent: agentFromArguments(args, false),
    ...withIntegrations(args),
  };
}

function agentFromArguments(args: Arguments, localMode: boolean): Record<string, unknown> {
  if (args.flags.has('network') && args.flags.has('no-network')) {
    throw new Error('--network cannot be combined with --no-network');
  }
  if (args.flags.has('browser') && args.flags.has('no-browser')) {
    throw new Error('--browser cannot be combined with --no-browser');
  }
  const configuredDriver = args.values.get('driver');
  const driver = (configuredDriver ?? (localMode ? 'codex' : undefined)) as AgentDriverName | undefined;
  const sandbox = (args.values.get('sandbox') ?? (localMode ? 'read-only' : undefined)) as
    SandboxMode | undefined;
  const capabilities = compact({
    profile: args.values.get('profile'),
    networkAccess: args.flags.has('network')
      ? true
      : args.flags.has('no-network')
        ? false
        : undefined,
    webSearch: args.values.get('web-search'),
    computerUse: args.flags.has('browser')
      ? 'browser'
      : args.flags.has('no-browser')
        ? 'disabled'
        : undefined,
    skills: repeated(args, 'skill'),
    apps: repeated(args, 'app'),
    mcpServers: repeated(args, 'mcp'),
  });
  return compact({
    driver,
    sandbox,
    model: args.values.get('model'),
    reasoningEffort: args.values.get('reasoning-effort'),
    reasoningSummary: args.values.get('reasoning-summary'),
    personality: args.values.get('personality'),
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
  });
}

function withIntegrations(args: Arguments): { integrations?: IntegrationAccessRequest } {
  const connectionSet = args.values.get('connection-set');
  const specifications = repeated(args, 'connection') ?? [];
  const allow = connectionOperations(args, 'allow-operation');
  const deny = connectionOperations(args, 'deny-operation');
  const connections = specifications.map((specification): ConnectionAccessRequest => {
    const separator = specification.lastIndexOf('=');
    const rawPreset = separator === -1 ? undefined : specification.slice(separator + 1);
    const hasPreset = rawPreset !== undefined && INTEGRATION_PERMISSION_PRESETS.includes(
      rawPreset as IntegrationPermissionPreset,
    );
    if (rawPreset !== undefined && !hasPreset) {
      throw new Error(`--connection preset ${JSON.stringify(rawPreset)} is invalid`);
    }
    const connection = hasPreset ? specification.slice(0, separator) : specification;
    if (!connection) throw new Error('--connection requires an account alias or ID');
    const allowed = allow.get(connection);
    const denied = deny.get(connection);
    allow.delete(connection);
    deny.delete(connection);
    return {
      connection,
      ...(hasPreset ? { preset: rawPreset as IntegrationPermissionPreset } : {}),
      ...(allowed?.length ? { allowOperations: allowed } : {}),
      ...(denied?.length ? { denyOperations: denied } : {}),
    };
  });
  const undeclared = [...allow.keys(), ...deny.keys()][0];
  if (undeclared) {
    throw new Error(`operation policy refers to undeclared connection ${JSON.stringify(undeclared)}`);
  }
  if (!connectionSet && connections.length === 0) return {};
  return {
    integrations: {
      ...(connectionSet ? { connectionSet } : {}),
      ...(connections.length > 0 ? { connections } : {}),
    },
  };
}

function connectionOperations(
  args: Arguments,
  option: 'allow-operation' | 'deny-operation',
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const value of repeated(args, option) ?? []) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
      throw new Error(`--${option} must use CONNECTION=PLUGIN.OPERATION`);
    }
    const connection = value.slice(0, separator);
    const operation = value.slice(separator + 1);
    result.set(connection, [...(result.get(connection) ?? []), operation]);
  }
  return result;
}

function repeated(args: Arguments, name: string): string[] | undefined {
  const values = args.multiple.get(name);
  return values && values.length > 0 ? values : undefined;
}

async function api(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const base = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  if (!base) throw new Error('RAT_THINGS_API_URL is required for remote commands');
  const url = new URL(path, `${base.replace(/\/$/, '')}/`);
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const unsignedHeaders: Record<string, string> = {
    host: url.host,
    accept: 'application/json',
    ...(encoded ? { 'content-type': 'application/json' } : {}),
    ...extraHeaders,
  };
  let headers = unsignedHeaders;
  if (process.env.AGENT_RUNTIME_UNSIGNED !== 'true') {
    const region = process.env.AWS_REGION ?? regionFromHostname(url.hostname);
    if (!region) throw new Error('AWS_REGION is required to sign control API requests');
    const query = Object.fromEntries(url.searchParams.entries());
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: 'execute-api',
      sha256: Sha256,
    });
    const signed = await signer.sign(new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      method,
      path: url.pathname,
      query,
      headers: unsignedHeaders,
      ...(encoded ? { body: encoded } : {}),
    }));
    headers = signed.headers;
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(encoded ? { body: encoded } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const value = text ? parseResponse(text) : {};
  if (!response.ok) {
    throw new Error(`runtime API returned HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  }
  return value;
}

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
}

async function doctor(args: Arguments): Promise<void> {
  const base = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  let validBase = base;
  let inferredRegion: string | undefined;
  if (base) {
    try {
      inferredRegion = regionFromHostname(new URL(base).hostname);
    } catch {
      validBase = undefined;
    }
  }
  const region = process.env.AWS_REGION ?? inferredRegion;
  const checks: DoctorCheck[] = [
    {
      name: 'node',
      status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail',
      detail: process.version,
    },
    {
      name: 'api-url',
      status: validBase ? 'pass' : base ? 'fail' : 'warning',
      detail: validBase ?? (base
        ? `RAT_THINGS_API_URL is not a valid URL: ${base}`
        : 'RAT_THINGS_API_URL is unset; remote checks skipped'),
    },
    {
      name: 'aws-region',
      status: process.env.AGENT_RUNTIME_UNSIGNED === 'true' || region ? 'pass' : 'warning',
      detail: process.env.AGENT_RUNTIME_UNSIGNED === 'true'
        ? 'unsigned local API mode'
        : region ?? 'set AWS_REGION for non-API-Gateway endpoints',
    },
    { name: 'codex-binary', status: 'pass', detail: process.env.CODEX_BINARY ?? 'codex' },
    { name: 'codex-auth', status: 'pass', detail: process.env.CODEX_AUTH_MODE ?? 'bedrock' },
  ];
  if (validBase) {
    checks.push(await publicEndpointCheck(validBase, '/health', 'api-health'));
    checks.push(await publicEndpointCheck(validBase, '/.well-known/rat-things', 'discovery'));
    try {
      await api('/v1/capability-profiles', 'GET');
      checks.push({ name: 'authenticated-api', status: 'pass', detail: 'control API authentication works' });
    } catch (error) {
      checks.push({
        name: 'authenticated-api',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (args.flags.has('json')) {
    print({
      version: '1',
      ok: !checks.some((check) => check.status === 'fail'),
      checks,
    });
  } else {
    for (const check of checks) {
      process.stdout.write(`${terminalText(check.status)}\t${terminalText(check.name)}\t${terminalText(check.detail)}\n`);
    }
  }
  if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

async function publicEndpointCheck(base: string, path: string, name: string): Promise<DoctorCheck> {
  try {
    const url = new URL(path, `${base.replace(/\/$/, '')}/`);
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return response.ok
      ? { name, status: 'pass', detail: `HTTP ${response.status}` }
      : { name, status: 'fail', detail: `HTTP ${response.status}: ${text.slice(0, 300)}` };
  } catch (error) {
    return { name, status: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
}

function parseArguments(argv: string[]): Arguments {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const multiple = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index] as string;
    if (item === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (item === '-h') {
      flags.add('help');
      continue;
    }
    if (!item.startsWith('--')) {
      if (item.startsWith('-')) {
        throw new Error(`unknown option ${JSON.stringify(item)}; use -- before text that starts with a dash`);
      }
      positionals.push(item);
      continue;
    }
    const name = item.slice(2);
    if (!name) throw new Error('use -- only as the end-of-options marker');
    if (booleanOptions.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name) && !repeatableOptions.has(name)) {
      throw new Error(`unknown option --${name}; run rat-things help --all`);
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (repeatableOptions.has(name)) {
        multiple.set(name, [...(multiple.get(name) ?? []), next]);
      } else {
        if (values.has(name)) throw new Error(`--${name} may be provided only once`);
        values.set(name, next);
      }
      index += 1;
    } else {
      throw new Error(`--${name} requires a value`);
    }
  }
  return { command, values, multiple, flags, positionals };
}

function normalizeArguments(argv: string[]): string[] {
  const first = argv[0];
  if (!first) return ['help'];
  if (first === '--help' || first === '-h') return ['help', ...argv.slice(1)];
  if (commands.has(first)) return argv;
  return ['chat', ...argv];
}

function validateCommandOptions(
  args: Arguments,
  options: {
    flags?: readonly string[];
    values?: readonly string[];
    multiple?: readonly string[];
  },
): void {
  const allowedFlags = new Set(['help', ...(options.flags ?? [])]);
  const allowedValues = new Set(['api-url', 'region', ...(options.values ?? [])]);
  const allowedMultiple = new Set(options.multiple ?? []);
  for (const flag of args.flags) {
    if (!allowedFlags.has(flag)) throw new Error(`--${flag} is not valid for ${args.command}`);
  }
  for (const name of args.values.keys()) {
    if (!allowedValues.has(name)) throw new Error(`--${name} is not valid for ${args.command}`);
  }
  for (const name of args.multiple.keys()) {
    if (!allowedMultiple.has(name)) throw new Error(`--${name} is not valid for ${args.command}`);
  }
}

function validatePositionals(
  args: Arguments,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (args.positionals.length < minimum) throw new Error(`${usage}: missing required argument`);
  if (args.positionals.length > maximum) {
    throw new Error(`${usage}: unexpected argument ${JSON.stringify(args.positionals[maximum])}`);
  }
}

function validateRootPositionals(args: Arguments): void {
  const rules: Record<string, readonly [number, number, string]> = {
    get: [1, 1, 'get RUN_ID'],
    cancel: [1, 1, 'cancel RUN_ID'],
    interrupt: [1, 1, 'interrupt RUN_ID'],
    console: [0, 1, 'console [RUN_ID]'],
    takeover: [1, 1, 'takeover RUN_ID'],
    handback: [1, 1, 'handback RUN_ID'],
    'computer-act': [1, 1, 'computer-act RUN_ID --file ACTION.json'],
    'teach-start': [1, 1, 'teach-start RUN_ID --name NAME'],
    'teach-stop': [1, 1, 'teach-stop RUN_ID'],
    'teach-discard': [1, 1, 'teach-discard RUN_ID'],
    plugins: [0, 0, 'plugins'],
    profiles: [0, 0, 'profiles'],
    connections: [0, 0, 'connections'],
    connect: [1, 1, 'connect PLUGIN'],
    grant: [1, 1, 'grant ACCOUNT --file GRANT.json'],
    rotate: [1, 1, 'rotate ACCOUNT --credential-file CREDENTIAL.json'],
    revoke: [1, 1, 'revoke ACCOUNT'],
    'connection-sets': [0, 0, 'connection-sets'],
    'connection-set': [0, 0, 'connection-set --file SET.json'],
    'source-bindings': [0, 0, 'source-bindings'],
    'bind-source': [0, 0, 'bind-source --file BINDING.json'],
    things: [0, 0, 'things'],
    thing: [1, 1, 'thing THING_ID'],
    'thing-create': [0, 0, 'thing-create --file THING.json'],
    'thing-update': [1, 1, 'thing-update THING_ID --file THING.json'],
    'thing-version': [2, 2, 'thing-version THING_ID REVISION'],
    'thing-versions': [1, 1, 'thing-versions THING_ID'],
    'thing-test': [1, 1, 'thing-test THING_ID'],
    'thing-publish': [1, 1, 'thing-publish THING_ID --test-run RUN_ID'],
    'thing-release': [0, 1, 'thing-release [THING_ID|--file THING.json]'],
    'thing-run': [1, 1, 'thing-run THING_ID'],
    'thing-pause': [1, 1, 'thing-pause THING_ID'],
    'thing-resume': [1, 1, 'thing-resume THING_ID'],
    'thing-archive': [1, 1, 'thing-archive THING_ID'],
    'thing-explain': [1, 1, 'thing-explain THING_ID'],
    routines: [0, 0, 'routines'],
    routine: [1, 1, 'routine ROUTINE_ID'],
    'routine-create': [0, 0, 'routine-create --file ROUTINE.json'],
    'routine-run': [1, 1, 'routine-run ROUTINE_ID'],
    'routine-pause': [1, 1, 'routine-pause ROUTINE_ID'],
    'routine-resume': [1, 1, 'routine-resume ROUTINE_ID'],
    'routine-delete': [1, 1, 'routine-delete ROUTINE_ID'],
    output: [1, 1, 'output RUN_ID'],
    artifact: [2, 2, 'artifact RUN_ID NAME'],
    files: [0, 0, 'files'],
    file: [1, 1, 'file NAME'],
    publish: [2, 2, 'publish file|site|video PATH'],
    list: [0, 0, 'list'],
    doctor: [0, 0, 'doctor'],
    help: [0, 0, 'help'],
  };
  const rule = rules[args.command];
  if (rule) validatePositionals(args, rule[0], rule[1], rule[2]);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function validationOptions(): { allowedRepositoryHosts?: string[]; allowedSandboxModes?: SandboxMode[] } {
  const raw = process.env.ALLOWED_REPOSITORY_HOSTS;
  const rawModes = process.env.ALLOWED_SANDBOX_MODES;
  return {
    ...(raw ? { allowedRepositoryHosts: raw.split(',').map((value) => value.trim()).filter(Boolean) } : {}),
    ...(rawModes ? { allowedSandboxModes: rawModes.split(',').map((value) => value.trim()).filter(Boolean) as SandboxMode[] } : {}),
  };
}

function regionConfig(): { region?: string } {
  return process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {};
}

function regionFromHostname(hostname: string): string | undefined {
  return hostname.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/)?.[1];
}

function inferProvider(url: string): 'github' | 'gitlab' | 'generic' {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  return 'generic';
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function requiredPositional(args: Arguments, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function thingDraftRevision(value: unknown): number {
  if (
    !value ||
    typeof value !== 'object' ||
    !('draft' in value) ||
    !value.draft ||
    typeof value.draft !== 'object' ||
    !('revision' in value.draft) ||
    typeof value.draft.revision !== 'number' ||
    !Number.isSafeInteger(value.draft.revision) ||
    value.draft.revision < 1
  ) {
    throw new Error('Thing response does not contain a valid draft revision');
  }
  return value.draft.revision;
}

function thingDraftIdentity(value: unknown): { revision: number; specHash: string } {
  const revision = thingDraftRevision(value);
  const draft = (value as { draft: { specHash?: unknown } }).draft;
  if (typeof draft.specHash !== 'string' || !/^[a-f0-9]{64}$/.test(draft.specHash)) {
    throw new Error('Thing response does not contain a valid draft spec hash');
  }
  return { revision, specHash: draft.specHash };
}

function parseResponse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(showAll: boolean): void {
  process.stdout.write(`Rat Things\n\n`);
  process.stdout.write(`  rat-things \"Ask Rat Things to do something\"\n`);
  process.stdout.write(`  rat-things --thread NAME \"Continue a named thread\"\n`);
  process.stdout.write(`  rat-things --new \"Start a fresh thread\"\n`);
  process.stdout.write(`  rat-things conversations list\n`);
  process.stdout.write(`  rat-things conversations search \"Find earlier work\"\n`);
  process.stdout.write(`  rat-things local \"Run on this computer\"\n`);
  process.stdout.write(`  rat-things files [--thread NAME]\n`);
  process.stdout.write(`  rat-things file NAME [--thread NAME]\n`);
  process.stdout.write(`  rat-things publish file|site|video PATH [--thread NAME]\n`);
  process.stdout.write(`\nRepeat a thread name to continue the same Codex thread.\n`);
  process.stdout.write(`Run rat-things help --all for agent and automation options.\n`);
  if (!showAll) return;
  process.stdout.write(`\nAgent and automation options\n\n`);
  process.stdout.write(`  rat-things chat [--thread NAME] [--driver codex] [--model ID]\n`);
  process.stdout.write(`    [--sandbox MODE] [--reasoning-effort LEVEL] [--reasoning-summary MODE]\n`);
  process.stdout.write(`    [--profile NAME]\n`);
  process.stdout.write(`    [--network|--no-network] [--web-search MODE] [--browser|--no-browser]\n`);
  process.stdout.write(`    [--skill NAME]... [--app NAME]... [--mcp NAME]...\n`);
  process.stdout.write(`    [--connection-set NAME] [--connection ACCOUNT[=PRESET]]...\n`);
  process.stdout.write(`    [--allow-operation ACCOUNT=PLUGIN.OP]... [--deny-operation ACCOUNT=PLUGIN.OP]...\n`);
  process.stdout.write(`    [--attach PATH]... [--reply-to MESSAGE_ID] [--delivery interrupt|defer]\n`);
  process.stdout.write(`    [--json] [--no-wait]\n`);
  process.stdout.write(`    [--idempotency-key KEY] [--poll-seconds N] [--wait-timeout N] \"...\"\n`);
  process.stdout.write(`  --api-url URL and --region REGION override RAT_THINGS_API_URL and AWS_REGION\n`);
  process.stdout.write(`\nLocal execution\n\n`);
  process.stdout.write(`  rat-things local [--sandbox MODE] [--network] [--events] \"...\"\n`);
  process.stdout.write(`    defaults to Codex with the device's cached ChatGPT login; use --driver mock for tests\n`);
  process.stdout.write(`\nRun management\n\n`);
  process.stdout.write(`  rat-things submit --file examples/run-request.json [--wait]\n`);
  process.stdout.write(`  rat-things get RUN_ID\n`);
  process.stdout.write(`  rat-things cancel RUN_ID\n`);
  process.stdout.write(`  rat-things watch RUN_ID [--follow] [--after SEQUENCE] [--json|--raw]\n`);
  process.stdout.write(`  rat-things steer RUN_ID "Additional direction"\n`);
  process.stdout.write(`  rat-things interrupt RUN_ID\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --result JSON\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --answer QUESTION=VALUE [--answer QUESTION=VALUE]...\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --answer-stdin SECRET_QUESTION [--answer-stdin QUESTION]...\n`);
  process.stdout.write(`\nConversations\n\n`);
  process.stdout.write(`  rat-things conversations list [--visibility visible|hidden|all] [--limit N] [--next-token TOKEN]\n`);
  process.stdout.write(`  rat-things conversations search QUERY [--limit N]\n`);
  process.stdout.write(`  rat-things conversation show PUBLIC_ID [--limit N] [--next-token TOKEN]\n`);
  process.stdout.write(`  rat-things conversation sources PUBLIC_ID [--json]\n`);
  process.stdout.write(`  rat-things conversation pin|unpin|hide|unhide|read|unread PUBLIC_ID\n`);
  process.stdout.write(`  rat-things conversation react|unreact PUBLIC_ID MESSAGE_ID 👍|❤️|🎉|👀\n`);
  process.stdout.write(`\nLive computer and demonstrations\n\n`);
  process.stdout.write(`  rat-things computer open [RUN_ID|--run RUN_ID|--thread NAME] [--port 4174]\n`);
  process.stdout.write(`  rat-things computer watch RUN_ID [--screenshot screen.jpg]\n`);
  process.stdout.write(`  rat-things computer takeover RUN_ID\n`);
  process.stdout.write(`  rat-things computer release RUN_ID\n`);
  process.stdout.write(`  rat-things computer navigate RUN_ID URL\n`);
  process.stdout.write(`  rat-things computer click RUN_ID (--ref REF | --x X --y Y)\n`);
  process.stdout.write(`  rat-things computer type RUN_ID [--ref REF] [--clear] [--submit] TEXT\n`);
  process.stdout.write(`  rat-things computer press RUN_ID KEY\n`);
  process.stdout.write(`  rat-things computer select RUN_ID REF VALUE\n`);
  process.stdout.write(`  rat-things computer scroll RUN_ID --delta-y PIXELS [--delta-x PIXELS]\n`);
  process.stdout.write(`  rat-things computer wait RUN_ID MILLISECONDS\n`);
  process.stdout.write(`  rat-things computer back RUN_ID\n`);
  process.stdout.write(`  rat-things computer act RUN_ID --file ACTION.json\n`);
  process.stdout.write(`  rat-things computer teach start RUN_ID --name NAME [--goal TEXT]\n`);
  process.stdout.write(`  rat-things computer teach stop|discard RUN_ID\n`);
  process.stdout.write(`    takeover is a temporary exclusive browser lease; teach-stop creates an unpublished draft Thing\n`);
  process.stdout.write(`    legacy computer/takeover/handback/computer-act/teach-* aliases remain supported\n`);
  process.stdout.write(`\nIntegrations\n\n`);
  process.stdout.write(`  rat-things plugins\n`);
  process.stdout.write(`  rat-things profiles\n`);
  process.stdout.write(`  rat-things connections\n`);
  process.stdout.write(`  rat-things connect PLUGIN --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`    [--auth-scheme SCHEME] [--access read-only|read-write|full] [--alias NAME]\n`);
  process.stdout.write(`  rat-things grant ACCOUNT --file GRANT.json\n`);
  process.stdout.write(`  rat-things rotate ACCOUNT --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`  rat-things revoke ACCOUNT\n`);
  process.stdout.write(`  rat-things connection-sets\n`);
  process.stdout.write(`  rat-things connection-set --file SET.json\n`);
  process.stdout.write(`  rat-things source-bindings\n`);
  process.stdout.write(`  rat-things bind-source --file BINDING.json\n`);
  process.stdout.write(`\nThings\n\n`);
  process.stdout.write(`  rat-things things [--limit 25] [--all]\n`);
  process.stdout.write(`  rat-things thing THING_ID\n`);
  process.stdout.write(`  rat-things thing-create --file THING.json\n`);
  process.stdout.write(`  rat-things thing-update THING_ID --file THING.json\n`);
  process.stdout.write(`  rat-things thing-version THING_ID REVISION\n`);
  process.stdout.write(`  rat-things thing-versions THING_ID\n`);
  process.stdout.write(`  rat-things thing-explain THING_ID [--target draft|active]\n`);
  process.stdout.write(`  rat-things thing-test THING_ID [--wait] [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things thing-release THING_ID [--poll-seconds N] [--wait-timeout N]\n`);
  process.stdout.write(`  rat-things thing-release --file THING.json [--poll-seconds N] [--wait-timeout N]\n`);
  process.stdout.write(`    validates, tests, waits for success, then publishes that exact draft revision\n`);
  process.stdout.write(`  rat-things thing-publish THING_ID --test-run RUN_ID\n`);
  process.stdout.write(`  rat-things thing-run THING_ID [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things thing-pause|thing-resume|thing-archive THING_ID\n`);
  process.stdout.write(`\nRoutines\n\n`);
  process.stdout.write(`  rat-things routines [--limit 25]\n`);
  process.stdout.write(`  rat-things routine ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-create --file ROUTINE.json\n`);
  process.stdout.write(`  rat-things routine-run ROUTINE_ID [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things routine-pause ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-resume ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-delete ROUTINE_ID\n`);
  process.stdout.write(`  rat-things output RUN_ID\n`);
  process.stdout.write(`  rat-things artifact RUN_ID input|output|events|patch\n`);
  process.stdout.write(`  rat-things files [--thread NAME | --run RUN_ID] [--json]\n`);
  process.stdout.write(`  rat-things file NAME [--thread NAME | --run RUN_ID] [--download PATH] [--json]\n`);
  process.stdout.write(`  rat-things publish file PATH [--thread NAME | --run RUN_ID] [--title TEXT]\n`);
  process.stdout.write(`  rat-things publish site ROOT [--entrypoint PATH] [--thread NAME | --run RUN_ID]\n`);
  process.stdout.write(`  rat-things publish video PATH [--poster PATH] [--thread NAME | --run RUN_ID]\n`);
  process.stdout.write(`  rat-things list [--limit 25]\n`);
  process.stdout.write(`  rat-things doctor [--json]\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
