import { describe, expect, it } from 'vitest';
import { conversationWorkState, completionReceiptIndex, answerCommands, messagePreview, fileCommands, readTextPreview, runPresentation } from '../../console/presentation.js';

import { coalesceActivities, groupActivities, createActivityProgress } from '../../console/activity.js';
import type { PublicAgentActivity } from '../../src/core/agent-activity-projection.js';
import { resolveArtifactLink, isMarkdownArtifact } from '../../console/artifact-links.js';

describe('shared client presentation', () => {
  it('distinguishes allocation, readiness, input, and completion without infrastructure states', () => {
    expect(runPresentation({status: 'running', ready: false}).label).toBe('Starting');
    expect(runPresentation({status: 'running', ready: true}).label).toBe('Working');
    expect(runPresentation({status: 'running', ready: true, pendingRequests: [{}]}).label).toBe('Needs input');
    for (const status of ['cancelling', 'cancelled', 'failed', 'succeeded']) {
      expect(runPresentation({status, ready: false, pendingRequests: [{}]}).label).not.toBe('Needs input');
    }
    expect(runPresentation({status: 'succeeded', settling: true}).label).toBe('Saving');
    expect(runPresentation({status: 'succeeded', settling: false}).label).toBe('Done');
  });

  it('quotes opaque file IDs and destination paths, and omits text preview for binary files', () => {
    const commands = fileCommands('my-thread', {id: 'opaque-id', path: "reports/customer's report.json", mediaType: 'application/problem+json; charset=utf-8'});
    expect(commands).toContainEqual(['Preview in terminal', "rat-things file 'opaque-id' --thread 'my-thread' --preview"]);
    expect(commands.at(-1)?.[1]).toContain("--download './reports/customer'\\''s report.json'");
    expect(fileCommands('my-thread', {id: 'image', path: 'image.png', mediaType: 'image/png'})).toHaveLength(2);
  });

  it('keeps nested downloads distinct and uses the requested selector', () => {
    const file = {id: 'a', path: 'reports/brief.md', mediaType: 'text/markdown'};
    expect(fileCommands('public-id', file, 'conversation').at(-1)?.[1]).toBe("rat-things file 'a' --conversation 'public-id' --download './reports/brief.md'");
    expect(fileCommands('public-id', {...file, path: 'archive/brief.md'}, 'conversation').at(-1)?.[1]).toContain("--download './archive/brief.md'");
  });

  it('offers escaped option answers while keeping secrets on stdin', () => {
    const request = {requestId: 'request', questions: [{id: 'audience', question: 'Who?', options: [{label: "Owner's team"}]}, {id: 'token', question: 'Token?', isSecret: true}]} as any;
    const commands = answerCommands('run', request);
    expect(commands[0]?.[0]).toBe("Answer: Owner's team (fill other VALUEs)");
    expect(commands[0]?.[1]).toContain("--answer-stdin 'token'");
    expect(commands[0]?.[1]).not.toContain('token=');
    expect(commands.at(-1)?.[1]).toContain("--answer 'audience=VALUE'");
  });

  it('uses readable plain text in sidebar previews', () => {
    expect(messagePreview('**Done**: [Updated report](.rat-things/artifacts/report.md)\n`npm test` <img src=x>')).toBe('Done: Updated report npm test');
    expect(messagePreview('x'.repeat(500))).toHaveLength(240);
  });

  it('preserves UTF-8 across stream chunks and accepts an exact-size file without a truncation warning', async () => {
    const bytes = new TextEncoder().encode('A🌍B');
    const response = new Response(new ReadableStream({start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3));
      controller.close();
    }}));
    expect(await readTextPreview(response, bytes.length)).toEqual({text: 'A🌍B', truncated: false});
  });

  it('stops reading and cancels large files once the preview bound is exceeded', async () => {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('abcdef'));
    }, cancel() {cancelled = true;}}, {highWaterMark: 0}));
    expect(await readTextPreview(response, 4)).toEqual({text: 'abcd', truncated: true});
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);
  });
});


describe('conversation Markdown links', () => {
  const files = [
    {id: 'current', path: 'reports/handoff.md'},
    {id: 'archive', path: 'archive/handoff.md'},
    {id: 'spaces', path: 'reports/review (final).md'},
  ];
  it('resolves full generated paths, encoded names, and links relative to a preview', () => {
    expect(resolveArtifactLink('./.rat-things/artifacts/reports/handoff.md', files)?.id).toBe('current');
    expect(resolveArtifactLink('reports/handoff.md', files)?.id).toBe('current');
    expect(resolveArtifactLink('.rat-things/artifacts/reports/review%20(final).md', files)?.id).toBe('spaces');
    expect(resolveArtifactLink('../archive/handoff.md', files, 'reports/handoff.md')?.id).toBe('archive');
    expect(resolveArtifactLink('.rat-things/artifacts/reports/handoff.md', files, 'archive/handoff.md')?.id).toBe('current');
  });
  it('never guesses filenames, escapes the catalog, or accepts ambiguous paths', () => {
    for (const link of ['handoff.md', 'missing.md', '../reports/handoff.md', '%2e%2e/reports/handoff.md', '/reports/handoff.md', '//evil.test/x', 'file:reports/handoff.md', 'javascript:alert(1)', 'data:text/html,x', 'reports/handoff.md?x', 'reports/%00handoff.md', '%zz']) {
      expect(resolveArtifactLink(link, files), link).toBeUndefined();
    }
    expect(resolveArtifactLink('../../reports/handoff.md', files, 'reports/handoff.md')).toBeUndefined();
    expect(resolveArtifactLink('reports/handoff.md', [...files, {id: 'duplicate', path: files[0]!.path}])).toBeUndefined();
  });
  it('recognizes Markdown metadata and extensions without overriding binary types', () => {
    expect(isMarkdownArtifact({mediaType: 'text/markdown; charset=utf-8'})).toBe(true);
    expect(isMarkdownArtifact({path: 'REPORT.MD', mediaType: 'text/plain'})).toBe(true);
    expect(isMarkdownArtifact({path: 'report.md', mediaType: 'image/png'})).toBe(false);
  });
});


describe('shared activity grouping', () => {
  const event = (sequence: number, changes: Partial<PublicAgentActivity> = {}): PublicAgentActivity => ({
    sequence, occurredAt: '2026-09-06T12:00:00Z', kind: 'message', status: 'updated', title: 'Writing response', ...changes,
  });
  it('collapses streaming deltas across polls and usage events, preserving phase changes and completion', () => {
    const progress = createActivityProgress();
    const writing = Array.from({length: 15}, (_, index) => event(index + 1));
    expect(progress(writing).map(item => item.title)).toEqual([]);
    expect(progress([event(15), event(16, {kind: 'usage'}), event(17)])).toEqual([]);
    const files = event(18, {kind: 'file', status: 'started', title: 'Editing files', detail: '2 files'});
    const completed = event(19, {...files, sequence: 19, status: 'completed', title: 'File changes applied'});
    expect(progress([files, completed]).map(item => item.title)).toEqual(['Updating files', 'Updating files']);
    expect(progress([event(20)])).toHaveLength(0);
    expect(groupActivities(coalesceActivities(writing))).toEqual([]);
  });
  it('keeps distinct commentary, file summaries, repeated failures, and chronological phases', () => {
    const events = [
      event(1, {kind: 'commentary', detail: 'Reviewing the source'}),
      event(2, {kind: 'commentary', detail: 'Found a missing dependency'}),
      event(3, {kind: 'file', detail: '1 file'}),
      event(4, {kind: 'file', detail: '2 files'}),
      event(5, {kind: 'error', status: 'failed', title: 'Tool failed'}),
      event(6, {kind: 'error', status: 'failed', title: 'Tool failed'}),
      event(7),
    ];
    expect(createActivityProgress()(events)).toHaveLength(6);
    expect(groupActivities(coalesceActivities(events))).toHaveLength(6);
    expect(coalesceActivities([event(1), event(2, {kind: 'file'}), event(3)]).map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(createActivityProgress(6)(events)).toHaveLength(0);
  });
});


describe('completion and conversation status presentation', () => {
  it('places the completion receipt after the final answer and before a subsequent turn', () => {
    const messages = [
      {role: 'user', receivedAt: '2026-09-06T12:00:00Z'},
      {role: 'assistant', receivedAt: '2026-09-06T12:00:06Z'},
      {role: 'user', receivedAt: '2026-09-06T12:00:10Z'},
      {role: 'assistant', receivedAt: '2026-09-06T12:00:20Z'},
    ];
    expect(completionReceiptIndex(messages, '2026-09-06T12:00:05Z')).toBe(1);
    expect(completionReceiptIndex(messages.slice(0, 2), '2026-09-06T12:00:05Z')).toBe(1);
    expect(completionReceiptIndex([], '2026-09-06T12:00:05Z')).toBe(-1);
  });
  it('requires a live question for input status and never treats unread as blocked work', () => {
    expect(conversationWorkState({status: 'running'})).toBe('working');
    expect(conversationWorkState({status: 'running'}, [{}])).toBe('needs-input');
    expect(conversationWorkState({status: 'failed'}, [{}])).toBe('failed');
    expect(conversationWorkState({status: 'idle'}, [{}])).toBe('ready');
    expect(conversationWorkState({status: 'idle', pendingCount: 1})).toBe('working');
  });
});
