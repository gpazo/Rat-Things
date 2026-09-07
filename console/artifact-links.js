// @ts-check

/** Resolve only an exact path in this conversation's catalog; never guess by basename.
 * @template {{id: string, path: string}} T
 * @param {string} href @param {readonly T[]} artifacts @param {string} [fromPath]
 * @returns {T | undefined}
 */
export function resolveArtifactLink(href, artifacts, fromPath = '') {
  let path;
  try { path = decodeURIComponent(href); } catch { return undefined; }
  if (!path || /[\u0000-\u001f\u007f\\?#]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) return undefined;
  const root = '.rat-things/artifacts/';
  path = path.replace(/^\.\//, '');
  const rooted = path.startsWith(root);
  if (rooted) path = path.slice(root.length);
  const parts = rooted || !fromPath ? [] : fromPath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const matches = artifacts.filter((artifact) => artifact.path === parts.join('/'));
  return matches.length === 1 ? matches[0] : undefined;
}

/** @param {{path?: string, mediaType?: string}} artifact */
export function isMarkdownArtifact(artifact) {
  const type = (artifact.mediaType ?? '').split(';')[0]?.trim().toLowerCase();
  return type === 'text/markdown' || type === 'text/x-markdown'
    || ((!type || type === 'text/plain' || type === 'application/octet-stream') && /\.(md|markdown)$/i.test(artifact.path ?? ''));
}
