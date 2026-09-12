import type { ArtifactCatalog } from '../domain/contracts.js';
import type { ConversationSearchKind, ConversationSearchRecord } from '../domain/conversations.js';
import { sha256Hex as digest } from '../domain/json.js';

export const MAX_SEARCH_QUERY_BYTES = 512;
export const MAX_SEARCH_QUERY_TOKENS = 8;
const MAX_SEARCH_DOCUMENT_TOKENS = 80;
const MAX_ASSISTANT_SEARCH_TOKENS = 60;
const MAX_SEARCH_SNIPPET_CHARACTERS = 280;

/** Give the last assistant message priority, then index file paths within the shared posting budget. */
export function completedTurnSearch(input: {
  ownerId: string;
  conversationId: string;
  turnId: string;
  assistantText: string | undefined;
  artifactCatalog: ArtifactCatalog | undefined;
  occurredAt: string;
  expiresAt: number;
}): ConversationSearchRecord[] {
  return [
    ...(input.assistantText !== undefined ? searchPostings({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      entryId: `turn-${digest(input.turnId)}`,
      kind: 'message',
      role: 'assistant',
      text: input.assistantText,
      occurredAt: input.occurredAt,
      expiresAt: input.expiresAt,
    }, MAX_ASSISTANT_SEARCH_TOKENS) : []),
    ...(input.artifactCatalog?.files.flatMap((file) => searchPostings({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      entryId: `turn-${digest(input.turnId)}-artifact-${file.id}`,
      kind: 'file',
      artifactId: file.id,
      text: file.path,
      occurredAt: file.createdAt,
      expiresAt: input.expiresAt,
    })) ?? []),
  ].slice(0, MAX_SEARCH_DOCUMENT_TOKENS);
}

export function searchPostings(input: {
  ownerId: string;
  conversationId: string;
  entryId: string;
  kind: ConversationSearchKind;
  text: string;
  occurredAt: string;
  expiresAt: number;
  role?: 'user' | 'assistant';
  artifactId?: string;
}, tokenLimit = MAX_SEARCH_DOCUMENT_TOKENS): ConversationSearchRecord[] {
  const snippet = searchSnippet(input.text);
  return searchableTokens(input.text, tokenLimit).map((token) => ({
    version: '1',
    itemType: 'search',
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    entryId: input.entryId,
    token,
    kind: input.kind,
    snippet,
    occurredAt: input.occurredAt,
    expiresAt: input.expiresAt,
    ...(input.role ? { role: input.role } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  }));
}

export function searchableTokens(value: string, limit: number): string[] {
  const tokens = value.normalize('NFKC').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2).map((token) => token.slice(0, 64)))]
    .slice(0, limit);
}

function searchSnippet(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_SEARCH_SNIPPET_CHARACTERS
    ? `${compact.slice(0, MAX_SEARCH_SNIPPET_CHARACTERS - 1).trimEnd()}…`
    : compact;
}
