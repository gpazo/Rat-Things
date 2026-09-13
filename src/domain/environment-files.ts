import { createHash } from 'node:crypto';
import type { EnvironmentFile, FileListParams } from './agents-api.js';
import { invalid } from './agents-api-validation.js';
import { absolutePath } from './environment-planning.js';

export function environmentDirectory(path = '/workspace'): string {
  absolutePath(path, 'path');
  if (path !== '/workspace' && !path.startsWith('/workspace/')) invalid('File access is limited to /workspace', 'path');
  return path.replace(/\/+$/, '');
}

/** A cursor is bound to the owner, environment, directory, and ordering that produced it. */
export function environmentFilePage(files: EnvironmentFile[], ownerId: string, environmentId: string, query: FileListParams) {
  const path = environmentDirectory(query.path ?? '/workspace');
  const order = query.order ?? 'desc';
  const scope = createHash('sha256').update(JSON.stringify([ownerId, environmentId, path, order])).digest('hex');
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer from 1 to 100', 'limit');
  const sorted = files.filter((file) => file.path.startsWith(`${path}/`)).sort((a, b) => {
    const left = a.path.split('/'); const right = b.path.split('/');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const comparison = (left[i] ?? '') < (right[i] ?? '') ? -1 : (left[i] ?? '') > (right[i] ?? '') ? 1 : 0;
      if (comparison) return order === 'asc' ? comparison : -comparison;
    }
    return 0;
  });
  let after: string | undefined;
  if (query.page) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(query.page, 'base64url').toString('utf8')); } catch { invalid('Invalid file cursor', 'page'); }
    if (typeof cursor !== 'object' || cursor === null || !('scope' in cursor) || cursor.scope !== scope || !('after' in cursor) || typeof cursor.after !== 'string') invalid('Invalid file cursor', 'page');
    after = cursor.after;
  }
  const index = after ? sorted.findIndex((file) => file.path === after) : -1;
  if (after && index < 0) invalid('Invalid file cursor', 'page');
  const data = sorted.slice(index + 1, index + limit + 1);
  const has_more = index + 1 + data.length < sorted.length;
  return { data, has_more, next: has_more ? Buffer.from(JSON.stringify({ scope, after: data.at(-1)!.path })).toString('base64url') : null };
}
