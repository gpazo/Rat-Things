import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const execute = promisify(execFile);
const conversationId = 'a'.repeat(64);
const now = '2026-08-26T20:00:00.000Z';

// This suite starts a fresh TypeScript CLI process for every command. Shared CI runners can take
// materially longer than developer machines to initialize those processes, so keep the assertion
// timeout above the per-process guard without weakening the production command timeout.
vi.setConfig({ testTimeout: 30_000 });

describe('conversation CLI-to-HTTP workflow', () => {
  const requests: Array<{ method: string; path: string; body: unknown; headers: IncomingMessage['headers'] }> = [];
  let followSnapshots = 0;
  let followRuns = 0;
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      body,
      headers: request.headers,
    });
    response.setHeader('content-type', 'application/json');
    const summary = {
      conversationId,
      title: 'Nvidia earnings review',
      threadKey: 'earnings',
      status: 'idle',
      pendingCount: 0,
      sourceKind: 'api',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      hidden: false,
      unread: true,
      lastMessagePreview: 'Compare today’s report with the previous quarter.',
    };
    if (request.method === 'GET' && request.url?.startsWith('/v1/conversations?')) {
      if (new URL(request.url, 'http://127.0.0.1').searchParams.get('visibility') === 'hidden') {
        return send(response, {
          items: [{
            ...summary,
            title: 'Title\u001b[31mRED\u001b[0m',
            lastMessagePreview: 'Preview\u001b]52;c;SGFja2Vk\u0007DONE',
          }],
        });
      }
      return send(response, { items: [summary], nextToken: 'older-page' });
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/conversations/search?')) {
      return send(response, {
        query: 'earnings',
        items: [{ conversation: summary, matches: [{ kind: 'message', role: 'assistant', snippet: 'Revenue increased.' , occurredAt: now }] }],
      });
    }
    if (request.method === 'GET' && request.url?.startsWith(`/v1/conversations/${conversationId}?`)) {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.searchParams.has('nextToken')) {
        return send(response, {
          ...summary,
          transcript: {
            compactedMessages: 2,
            messages: [
              { role: 'assistant', content: 'Earlier context.', messageId: 'message-0', receivedAt: now },
            ],
          },
        });
      }
      return send(response, {
        ...summary,
        transcript: {
          compactedMessages: 2,
          nextToken: 'next-transcript',
          messages: [
            { role: 'user', content: 'Read https://investor.nvidia.com/report', messageId: 'message-1', receivedAt: now, attachments: [{ id: 'artifact-1' }] },
            { role: 'assistant', content: 'Revenue increased.', messageId: 'message-2', receivedAt: now },
          ],
        },
      });
    }
    if (request.method === 'GET' && request.url === `/v1/conversations/${conversationId}/artifacts`) {
      return send(response, {
        files: [{
          id: 'artifact-1',
          path: 'earnings.txt',
          mediaType: 'text/plain',
          bytes: 12,
          createdAt: now,
          sourceRunId: 'run-1',
          sha256: 'b'.repeat(64),
        }],
      });
    }
    if (request.method === 'POST' && request.url === '/v1/runs') {
      return send(response, { runId: 'run-1', status: 'queued', createdAt: now, updatedAt: now }, 202);
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/runs/run-1/events?')) {
      return send(response, {
        runId: 'run-1',
        active: true,
        ready: true,
        oldestSequence: 1,
        nextSequence: 3,
        events: [{ sequence: 1, occurredAt: now, kind: 'web_search', status: 'completed', title: 'Web search completed' }],
        pendingRequests: [{
          requestId: 'request-1',
          kind: 'input',
          title: 'Agent needs input',
          receivedAt: now,
          questions: [
            { id: 'scope', question: 'Which quarter?', isOther: false, isSecret: false, options: [{ label: 'Q2' }] },
            { id: 'token', question: 'API token?', isOther: false, isSecret: true },
          ],
        }],
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/runs/run-gap/events?')) {
      return send(response, {
        runId: 'run-gap',
        active: false,
        ready: false,
        oldestSequence: 4,
        nextSequence: 5,
        events: [{ sequence: 4, occurredAt: now, kind: 'agent', status: 'completed', title: 'Newest retained activity' }],
        pendingRequests: [],
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/runs/run-follow/events?')) {
      followSnapshots += 1;
      return send(response, {
        runId: 'run-follow',
        active: followSnapshots < 2,
        ready: true,
        oldestSequence: 1,
        nextSequence: followSnapshots + 1,
        events: [{ sequence: followSnapshots, occurredAt: now, kind: 'agent', status: 'updated', title: `Update ${followSnapshots}` }],
        pendingRequests: [],
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/runs/run-terminal-race/events?')) {
      return send(response, {
        error: { code: 'conflict', message: 'run does not have an active interactive execution' },
      }, 409);
    }
    if (request.method === 'GET' && request.url === '/v1/runs/run-follow') {
      followRuns += 1;
      return send(response, {
        runId: 'run-follow',
        status: followRuns < 2 ? 'running' : 'succeeded',
        createdAt: now,
        updatedAt: now,
      });
    }
    if (request.method === 'GET' && request.url === '/v1/runs/run-terminal-race') {
      return send(response, {
        runId: 'run-terminal-race',
        status: 'succeeded',
        createdAt: now,
        updatedAt: now,
      });
    }
    if (request.method === 'POST' && request.url === '/v1/runs/run-1/requests/request-1/respond') {
      return send(response, { ok: true, operation: 'respond' });
    }
    if (request.method === 'POST' && request.url === '/v1/runs/run-1/computer/action') {
      return send(response, {
        version: '1',
        runId: 'run-1',
        available: true,
        control: 'human',
        viewport: { width: 1280, height: 720 },
        observedAt: now,
        page: { url: 'https://example.com', title: 'Example' },
        imageDataUrl: 'data:image/jpeg;base64,AA==',
        teach: { state: 'idle' },
      });
    }
    if (request.method === 'POST' && request.url?.endsWith('/organization')) {
      return send(response, { ...summary, pinned: true });
    }
    if (request.method === 'POST' && request.url?.endsWith('/reactions')) {
      return send(response, { emoji: '👍', reacted: true });
    }
    return send(response, { error: `unhandled ${request.method} ${request.url}` }, 404);
  });

  let apiUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  });

  it('inherits a conversation policy when chat has no explicit agent options', async () => {
    await cli(['chat', '--thread', 'earnings', '--no-wait', 'Continue the review'], apiUrl);
    const submitted = [...requests].reverse().find(request => request.method === 'POST' && request.path === '/v1/runs');
    expect(submitted?.body).toMatchObject({prompt: 'Continue the review', thread: {key: 'earnings'}});
    expect(submitted?.body).not.toHaveProperty('agent');
  });

  it('lists, searches, pages, organizes, reacts, and collects sources', async () => {
    const listed = await cli(['conversations', 'list', '--visibility', 'all', '--limit', '10'], apiUrl);
    expect(listed.stdout).toContain('Nvidia earnings review · idle · api · unread');
    expect(listed.stdout).toContain('Next token: older-page');
    expect(requests.at(-1)?.path).toBe('/v1/conversations?visibility=all&limit=10');

    const searched = await cli(['conversations', 'search', 'earnings'], apiUrl);
    expect(searched.stdout).toContain('assistant: Revenue increased.');

    const shown = await cli(['conversation', 'show', conversationId, '--limit', '25'], apiUrl);
    expect(shown.stdout).toContain('2 older messages compacted');
    expect(shown.stdout).toContain('message message-1');
    expect(shown.stdout).toContain('Next older page: --next-token next-transcript');

    const sources = await cli(['conversation', 'sources', conversationId], apiUrl);
    expect(sources.stdout).toContain('link\tuser\tinvestor.nvidia.com\thttps://investor.nvidia.com/report\tmessage-1');
    expect(sources.stdout).toContain('file\tearnings.txt\ttext/plain\t12 bytes\tartifact-1');
    expect(requests.some((request) => request.path.includes('nextToken=next-transcript'))).toBe(true);
    expect(requests.some((request) => request.path === `/v1/conversations/${conversationId}/artifacts`)).toBe(true);

    await cli(['conversation', 'pin', conversationId], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { pinned: true } });
    await cli(['conversation', 'react', conversationId, 'message-2', '👍'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { emoji: '👍', reacted: true } });
  });

  it('sends replies, delivery policy, and bounded attachments from chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-things-cli-attachment-'));
    const attachment = join(directory, 'earnings.txt');
    await writeFile(attachment, 'live earnings evidence', { mode: 0o600 });
    try {
      await cli([
        'chat', '--thread', 'earnings', '--driver', 'mock', '--no-wait',
        '--connection', 'slack=read-write',
        '--allow-operation', 'slack=slack.messages.search,slack.messages.post',
        '--deny-operation', 'slack=slack.files.write,slack.canvases.write',
        '--attach', attachment, '--reply-to', 'message-1', '--delivery', 'interrupt',
        'Compare the attached evidence.',
      ], apiUrl);
      const request = [...requests].reverse().find((candidate) => candidate.path === '/v1/runs');
      expect(request).toMatchObject({
        method: 'POST',
        body: {
          version: '1',
          prompt: 'Compare the attached evidence.',
          thread: {
            key: 'earnings',
            delivery: 'interrupt',
            replyToMessageId: 'message-1',
            attachments: [{ name: 'earnings.txt', mediaType: 'text/plain' }],
          },
          integrations: {
            connections: [{
              connection: 'slack',
              preset: 'read-write',
              allowOperations: ['slack.messages.search', 'slack.messages.post'],
              denyOperations: ['slack.files.write', 'slack.canvases.write'],
            }],
          },
        },
      });
      const uploaded = (request?.body as { thread: { attachments: Array<{ base64: string; sha256: string }> } }).thread.attachments[0]!;
      expect(Buffer.from(uploaded.base64, 'base64').toString('utf8')).toBe('live earnings evidence');
      expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders readable activity, structured response commands, and typed computer actions', async () => {
    const watched = await cli(['watch', 'run-1'], apiUrl);
    expect(watched.stdout).toContain('✓ Web search completed');
    expect(watched.stderr).toContain('scope: Which quarter?');
    expect(watched.stderr).toContain('--answer scope=VALUE');
    expect(watched.stderr).toContain('--answer-stdin token');
    expect(watched.stderr).not.toContain('--answer token=VALUE');

    const responded = await cliWithInput([
      'respond', 'run-1', 'request-1', '--answer', 'scope=Q2', '--answer-stdin', 'token',
    ], apiUrl, 'private-token\n');
    expect(responded.stdout).not.toContain('private-token');
    expect(responded.stderr).not.toContain('private-token');
    expect(requests.at(-1)).toMatchObject({
      body: { result: { answers: { scope: { answers: ['Q2'] }, token: { answers: ['private-token'] } } } },
    });

    await cli(['computer', 'navigate', 'run-1', 'https://example.com'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { action: { type: 'navigate', url: 'https://example.com' } } });
    await cli(['computer', 'click', 'run-1', '--x', '640', '--y', '360'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { action: { type: 'click', x: 640, y: 360 } } });
    await cli(['computer', 'type', 'run-1', '--ref', 'r2', '--clear', '--submit', 'quarterly revenue'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { action: { type: 'type', ref: 'r2', clear: true, submit: true, text: 'quarterly revenue' } } });
    await cli(['computer', 'scroll', 'run-1', '--delta-y', '600'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { action: { type: 'scroll', deltaY: 600 } } });

    await cli(['computer', 'type', 'run-1', '--', '--secret-looking-text'], apiUrl);
    expect(requests.at(-1)).toMatchObject({ body: { action: { type: 'type', text: '--secret-looking-text' } } });
  });

  it('rejects unknown options, extra operands, ambiguous modes, and duplicate answers before acting', async () => {
    const before = requests.length;
    await expectCliFailure(
      ['chat', '--thread', 'earnings', '--driver', 'mock', '--no-wait', '--attch', 'missing.pdf', 'Use it'],
      apiUrl,
      'unknown option --attch',
    );
    await expectCliFailure(['conversation', 'hide', conversationId, '--dry-run', 'true'], apiUrl, 'unknown option --dry-run');
    await expectCliFailure(['conversation', 'pin', conversationId, 'extra'], apiUrl, 'unexpected argument');
    await expectCliFailure(
      ['computer', 'navigate', 'run-1', 'https://example.com', '--dry-run', 'true'],
      apiUrl,
      'unknown option --dry-run',
    );
    await expectCliFailure(
      ['computer', 'navigte', 'run-1', 'https://example.com'],
      apiUrl,
      'unknown computer subcommand',
    );
    await expectCliFailure(
      ['respond', 'run-1', 'request-1', '--answer', 'scope=Q1', '--answer', 'scope=Q2'],
      apiUrl,
      'answered more than once',
    );
    await expectCliFailure(['watch', 'run-1', '--json', '--raw'], apiUrl, '--json cannot be combined with --raw');
    await expectCliFailure(
      ['chat', '--thread', 'earnings', '--driver', 'mock', '--no-wait', '--reply-to', '', 'Continue'],
      apiUrl,
      '--reply-to cannot be empty',
    );
    expect(requests.length).toBe(before);
  });

  it('emits parseable follow JSONL, warns about activity loss, and provides contextual help', async () => {
    followSnapshots = 0;
    followRuns = 0;
    const followed = await cli(['watch', 'run-follow', '--follow', '--json', '--poll-seconds', '1'], apiUrl);
    const snapshots = followed.stdout.trim().split('\n').map((line) => JSON.parse(line) as { runId: string });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((snapshot) => snapshot.runId === 'run-follow')).toBe(true);

    const terminalRace = await cli([
      'watch', 'run-terminal-race', '--follow', '--poll-seconds', '1',
    ], apiUrl);
    expect(terminalRace.stderr).toContain('Run run-terminal-race: succeeded');

    const gap = await cli(['watch', 'run-gap'], apiUrl);
    expect(gap.stdout).toContain('Newest retained activity');
    expect(gap.stderr).toContain('live activity 1-3 is no longer in the bounded ring');
    expect(gap.stderr).toContain('terminal events JSONL artifact');

    const conversationHelp = await cli(['conversation', '--help'], apiUrl);
    expect(conversationHelp.stdout).toContain('Rat Things conversations');
    expect(conversationHelp.stdout).toContain('conversation sources PUBLIC_ID');
    const chatHelp = await cli(['chat', '--help'], apiUrl);
    expect(chatHelp.stdout).toContain('Rat Things chat');
    expect(chatHelp.stdout).toContain('Use -- before prompt text that starts with a dash.');
    const watchHelp = await cli(['watch', '--help'], apiUrl);
    expect(watchHelp.stdout).toContain('Rat Things live Run interaction');
    expect(watchHelp.stdout).toContain('watch RUN_ID');
    const respondHelp = await cli(['respond', '--help'], apiUrl);
    expect(respondHelp.stdout).toContain('respond RUN_ID REQUEST_ID');
    expect(respondHelp.stdout).toContain('--answer-stdin SECRET_QUESTION');
  });

  it('neutralizes terminal controls in human output while preserving JSON data', async () => {
    const readable = await cli(['conversations', 'list', '--visibility', 'hidden'], apiUrl);
    expect(readable.stdout).not.toContain('\u001b');
    expect(readable.stdout).not.toContain('\u0007');
    expect(readable.stdout).toContain('Title�[31mRED�[0m');
    expect(readable.stdout).toContain('Preview�]52;c;SGFja2Vk�DONE');

    const machine = await cli(['conversations', 'list', '--visibility', 'hidden', '--json'], apiUrl);
    const parsed = JSON.parse(machine.stdout) as { items: Array<{ title: string; lastMessagePreview: string }> };
    expect(parsed.items[0]).toMatchObject({
      title: 'Title\u001b[31mRED\u001b[0m',
      lastMessagePreview: 'Preview\u001b]52;c;SGFja2Vk\u0007DONE',
    });
  });
});

async function cli(argumentsValue: string[], apiUrl: string): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [
    resolve('node_modules/tsx/dist/cli.mjs'),
    'src/cli.ts',
    ...argumentsValue,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAT_THINGS_API_URL: apiUrl,
      AGENT_RUNTIME_UNSIGNED: 'true',
    },
    timeout: 20_000,
  });
}

async function cliWithInput(
  argumentsValue: string[],
  apiUrl: string,
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      'src/cli.ts',
      ...argumentsValue,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAT_THINGS_API_URL: apiUrl,
        AGENT_RUNTIME_UNSIGNED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`CLI exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

async function expectCliFailure(
  argumentsValue: string[],
  apiUrl: string,
  message: string,
): Promise<void> {
  await expect(cli(argumentsValue, apiUrl)).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(response: import('node:http').ServerResponse, value: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(value));
}
