import { describe, expect, it } from 'vitest';
import {
  completedTurnSearch,
  MAX_SEARCH_QUERY_TOKENS,
  searchableTokens,
  searchPostings,
} from '../../src/conversation/search.js';
import type { ArtifactCatalog } from '../../src/domain/contracts.js';
import { artifact, freeze, timestamp } from './fixtures.js';

describe('conversation search normalization', () => {
  it('normalizes Unicode, case, and duplicates while retaining first occurrence order', () => {
    expect(searchableTokens('ＣＡＦÉ café CAFÉ alpha_beta release-1 naïve 42 7 a 🌍 发布 ﬁle', 20))
      .toEqual(['café', 'alpha_beta', 'release-1', 'naïve', '42', '发布', 'file']);
  });

  it('deduplicates bounded tokens before applying the query limit', () => {
    const prefix = 'x'.repeat(64);
    expect(searchableTokens(`${prefix}first ${prefix}second other last`, 2)).toEqual([prefix, 'other']);
    const words = Array.from({ length: 10 }, (_, index) => `term${index}`);
    expect(searchableTokens(words.join(' '), MAX_SEARCH_QUERY_TOKENS)).toEqual(words.slice(0, 8));
    expect(searchableTokens('valid words', 0)).toEqual([]);
    expect(searchableTokens('a 1 !!!', 8)).toEqual([]);
  });

  it('creates bounded owner-scoped postings without mutating input or dropping zero expiry', () => {
    const input = freeze({
      ownerId: 'owner-1', conversationId: 'conversation-1', entryId: 'entry-1', kind: 'message' as const,
      text: '  Release\n deployment\t release ', occurredAt: timestamp, expiresAt: 0, role: 'user' as const,
    });
    const before = structuredClone(input);
    const postings = searchPostings(input);
    expect(postings).toEqual(['release', 'deployment'].map((token) => ({
      version: '1', itemType: 'search', ownerId: 'owner-1', conversationId: 'conversation-1', entryId: 'entry-1',
      token, kind: 'message', snippet: 'Release deployment release', occurredAt: timestamp, expiresAt: 0, role: 'user',
    })));
    expect(input).toEqual(before);
    expect(searchPostings({ ...input, text: '' })).toEqual([]);
  });

  it('bounds document tokens and snippets without including absent metadata', () => {
    const words = Array.from({ length: 90 }, (_, index) => `word${index}`);
    const text = words.join(' ');
    const postings = searchPostings({
      ownerId: 'owner-1', conversationId: 'conversation-1', entryId: 'entry-1', kind: 'file',
      text, occurredAt: timestamp, expiresAt: 600,
    });
    expect(postings.map((posting) => posting.token)).toEqual(words.slice(0, 80));
    expect(postings[0]?.snippet).toBe(`${text.slice(0, 279).trimEnd()}…`);
    expect(postings[0]).not.toHaveProperty('role');
    expect(postings[0]).not.toHaveProperty('artifactId');
  });
});

describe('completed turn search postings', () => {
  const catalog: ArtifactCatalog = { version: '1', files: Array.from({ length: 20 }, (_, index) => ({
    id: `file-${index}`, path: `folder-${index}/file-${index}.txt`, mediaType: 'text/plain', bytes: 0,
    createdAt: timestamp, sourceRunId: 'private-run', file: artifact(`private-artifact-${index}`),
  })) };

  it('prioritizes assistant tokens and then file paths under the shared budget in catalog order', () => {
    const input = freeze({
      ownerId: 'owner-1', conversationId: 'conversation-1', turnId: 'turn-1',
      assistantText: Array.from({ length: 70 }, (_, index) => `answer${index}`).join(' '),
      artifactCatalog: catalog, occurredAt: '2026-08-04T12:00:00.000Z', expiresAt: 600,
    });
    const before = structuredClone(input);
    const postings = completedTurnSearch(input);
    expect(postings).toHaveLength(80);
    expect(postings.slice(0, 60).map((posting) => posting.token)).toEqual(
      Array.from({ length: 60 }, (_, index) => `answer${index}`),
    );
    expect(postings[0]).toMatchObject({ kind: 'message', role: 'assistant', occurredAt: input.occurredAt });
    expect(postings[60]).toMatchObject({ kind: 'file', artifactId: 'file-0', token: 'folder-0', occurredAt: timestamp });
    expect(postings.at(-1)).toMatchObject({ artifactId: 'file-6', token: 'file-6' });
    expect(JSON.stringify(postings)).not.toMatch(/private-run|private-artifact|bucket/);
    expect(input).toEqual(before);
  });

  it('uses available capacity for files when assistant text is empty or absent', () => {
    const input = freeze({
      ownerId: 'owner-1', conversationId: 'conversation-1', turnId: 'turn-1', assistantText: undefined,
      artifactCatalog: catalog, occurredAt: timestamp, expiresAt: 0,
    });
    const postings = completedTurnSearch(input);
    expect(postings).toHaveLength(60);
    expect(postings.every((posting) => posting.kind === 'file' && posting.expiresAt === 0)).toBe(true);
    expect(completedTurnSearch({ ...input, assistantText: '' })).toEqual(postings);
    expect(completedTurnSearch({ ...input, artifactCatalog: undefined })).toEqual([]);
  });
});
