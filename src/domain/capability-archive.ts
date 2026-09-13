import { unzipSync, zipSync } from 'fflate';
import { parseDocument } from 'yaml';
import { invalid } from './agents-api-validation.js';

export interface CapabilityFile { path: string; data: Uint8Array }
export interface CapabilityArchive { name: string; description: string; files: CapabilityFile[]; zip: Uint8Array }

/** Decode bounded archives to plain files. ZIP permissions never create links or devices. */
export function capabilityArchive(input: CapabilityFile[], kind: 'skill' | 'plugin', source: 'upload' | 'stored' = 'upload'): CapabilityArchive {
  let files = input;
  let originalZip: Uint8Array | undefined;
  if (files.length === 1 && files[0]!.path.toLowerCase().endsWith('.zip')) {
    // The compressed-upload limit does not apply to our own ZIP representation
    // of a multipart directory upload. File count and expanded sizes always do.
    if (source === 'upload' && files[0]!.data.byteLength > 50 * 1024 * 1024) invalid('Capability ZIP exceeds 50 MiB', 'files');
    const bytes = Uint8Array.from(files[0]!.data);
    const names = new Set<string>();
    const entries: string[] = [];
    try { unzipSync(bytes, { filter: (entry) => {
      archivePath(entry.name);
      if (names.has(entry.name) || entry.originalSize > 25 * 1024 * 1024) throw new Error('Invalid ZIP limits');
      names.add(entry.name);
      if (!entry.name.endsWith('/')) entries.push(entry.name);
      if (entries.length > 500) throw new Error('Too many files');
      return false;
    } }); } catch { invalid('Invalid capability ZIP archive', 'files'); }
    // Expand one entry at a time during setup. A small compressed archive can
    // legitimately expand beyond 50 MiB without holding every file in memory.
    files = entries.map((path) => ({ path, get data() {
      try { return unzipSync(bytes, { filter: (entry) => entry.name === path })[path]!; }
      catch { return invalid('Invalid capability ZIP archive', 'files'); }
    } }));
    originalZip = bytes;
  }
  if (!files.length || files.length > 500) invalid('A capability requires 1–500 files', 'files');
  if (!originalZip && files.some((file) => file.data.byteLength > 25 * 1024 * 1024)) invalid('Capability files exceed the size limit', 'files');
  files.forEach((file) => archivePath(file.path));
  const marker = kind === 'skill' ? 'SKILL.md' : '.codex-plugin/plugin.json';
  const matches = (path: string) => kind === 'skill' ? path.toLowerCase() === marker.toLowerCase() : path === marker;
  if (kind === 'skill' && files.filter((file) => file.path.split('/').at(-1)?.toLowerCase() === 'skill.md').length !== 1) invalid('A skill must contain exactly one SKILL.md', 'files');
  let metadataFile = files.find((file) => matches(file.path));
  if (!metadataFile) {
    const candidates = files.filter((file) => kind === 'skill' ? file.path.toLowerCase().endsWith(`/${marker.toLowerCase()}`) : file.path.endsWith(`/${marker}`));
    if (candidates.length !== 1) invalid(`Archive must contain one ${marker}`, 'files');
    const prefix = candidates[0]!.path.slice(0, -marker.length);
    if (files.some((file) => !file.path.startsWith(prefix))) invalid('Archive must contain a single capability directory', 'files');
    files = files.map((file) => ({ path: file.path.slice(prefix.length), get data() { return file.data; } }));
    metadataFile = files.find((file) => matches(file.path))!;
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) invalid('Duplicate capability path', 'files');
  const text = Buffer.from(metadataFile.data).toString('utf8');
  let metadata: unknown;
  try {
    if (kind === 'plugin') metadata = JSON.parse(text);
    else {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!frontmatter) throw new Error('Missing frontmatter');
      const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid frontmatter');
      metadata = document.toJS({ maxAliasCount: 10 });
    }
  } catch { invalid(`Invalid ${marker}`, 'files'); }
  if (!record(metadata) || typeof metadata.name !== 'string' || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(metadata.name) || metadata.name !== metadata.name.toLowerCase() || [...metadata.name].length > 64 || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) invalid('Capability name or description is invalid', 'files');
  files = files.map((file) => matches(file.path) ? { path: marker, get data() { return file.data; } } : file);
  return { name: metadata.name, description: metadata.description, files, zip: originalZip ?? zipSync(Object.fromEntries(files.map((file) => [`${metadata.name}/${file.path}`, file.data])), { mtime: new Date(1980, 0, 1) }) };
}

export function archivePath(path: string): string {
  if (!path || path.startsWith('/') || /[\\:\0]/.test(path) || path.split('/').some((part) => part === '.' || part === '..') || path.startsWith('~')) invalid('Invalid capability file path', 'files');
  return path;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
