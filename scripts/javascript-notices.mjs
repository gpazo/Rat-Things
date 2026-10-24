import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readRegularFile } from './native-build-files.mjs';

const limits = { packages: 512, entries: 32768, packageEntries: 8192, fileBytes: 1024 ** 2, totalBytes: 16 * 1024 ** 2 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const safePath = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024
  && !/[\\:\u0000-\u001f\u007f]/.test(value) && value.normalize('NFC') === value
  && value.split('/').length <= 32 && value.split('/').every(part => part && part !== '.' && part !== '..');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const kinds = new Set(['license', 'attribution']);
export const noticeIndexBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function noticeKind(path) {
  const parts = path.split('/'); const name = parts.at(-1);
  if (/^(?:licen[sc]e|copying)(?:$|[._-])/i.test(name)
    || parts.slice(0, -1).some(part => /^(?:licen[sc]es?)$/i.test(part))) return 'license';
  if (/^(?:notice|copyright(?:notice)?|authors)(?:$|[._-])/i.test(name)
    || parts.slice(0, -1).some(part => /^notices?$/i.test(part))) return 'attribution';
  return undefined;
}

function localReference(from, target) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return undefined;
  let path;
  try { path = decodeURIComponent(target.split('#')[0]); } catch { throw new Error('Invalid local legal reference.'); }
  if (!path || path.startsWith('/') || path.includes('?')) throw new Error('Invalid local legal reference.');
  const resolved = posix.normalize(posix.join(posix.dirname(from), path));
  if (!safePath(resolved) || resolved.split('/').includes('node_modules')) throw new Error('Legal reference escapes its package.');
  return resolved;
}

export function noticeReferences(from, text) {
  return sorted(new Set([...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)]
    .map(match => localReference(from, match[1] ?? match[2])).filter(Boolean)));
}

export function checkedNoticeDependencies(dependencies, lock) {
  if (!Array.isArray(dependencies) || dependencies.length > limits.packages) throw new Error('Unbounded JavaScript dependency inventory.');
  const paths = new Set();
  for (const value of dependencies) {
    const pinned = lock?.packages?.[value.path];
    if (!safePath(value.path) || !/^node_modules\//.test(value.path) || paths.has(value.path)
      || typeof value.name !== 'string' || !value.name || typeof value.version !== 'string' || !value.version
      || !pinned || pinned.version !== value.version || (pinned.name && pinned.name !== value.name)
      || typeof pinned.integrity !== 'string' || !pinned.integrity || pinned.integrity !== value.integrity
      || pinned.resolved !== value.resolved) throw new Error('JavaScript notice owner differs from the dependency lock.');
    paths.add(value.path);
  }
  return [...dependencies].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function directorySnapshot(root, path, budget) {
  const filename = join(root, path);
  if (!(await lstat(filename)).isDirectory()) throw new Error('Notice input directory is a symlink or special file.');
  const entries = [];
  for await (const entry of await opendir(filename)) {
    if (++budget.total > limits.entries || ++budget.package > limits.packageEntries) throw new Error('JavaScript notice tree exceeds its entry limit.');
    if (!safePath(entry.name) || entry.name.includes('/')) throw new Error('Invalid notice input name.');
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'special';
    if (type === 'special') throw new Error('Notice inputs must not contain symlinks or special files.');
    entries.push({ name: entry.name, type });
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function packageTree(root, path, budget) {
  for (let index = 1; index <= path.split('/').length; index++) {
    if (!(await lstat(join(root, ...path.split('/').slice(0, index)))).isDirectory()) throw new Error('Notice owner crosses a symlink or special directory.');
  }
  const directories = []; const files = [];
  async function walk(relative = '') {
    const directory = relative ? `${path}/${relative}` : path;
    if (!safePath(directory)) throw new Error('Notice input tree exceeds its path limit.');
    const entries = await directorySnapshot(root, directory, budget);
    directories.push({ path: directory, entries });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === 'directory') await walk(child); else files.push(child);
    }
  }
  await walk();
  return { directories, files: sorted(files) };
}

function legalText(bytes) {
  if (!bytes.length || bytes.length > limits.fileBytes) throw new Error('Legal text is empty or exceeds its byte limit.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Legal text is not bounded UTF-8 text.');
  return text;
}

function supplementsFor(document, surface, dependencies, lock) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.packages) || document.packages.length > limits.packages) throw new Error('Invalid JavaScript notice supplements.');
  const selected = new Map(); const seen = new Set();
  for (const item of document.packages) {
    const pinned = lock?.packages?.[item.packagePath];
    if (!safePath(item.packagePath) || seen.has(item.packagePath) || !pinned || pinned.version !== item.version
      || pinned.integrity !== item.integrity || typeof item.name !== 'string' || !item.name
      || !Array.isArray(item.surfaces) || !item.surfaces.length || item.surfaces.some(value => !['app', 'worker'].includes(value))
      || !Array.isArray(item.files) || !item.files.length || item.files.length > 32) throw new Error('Stale or invalid JavaScript notice supplement.');
    seen.add(item.packagePath);
    for (const file of item.files) {
      if (!safePath(file.path) || !file.path.startsWith('runtime/notices/') || !kinds.has(file.kind) || !sha256(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > limits.fileBytes
        || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(file.source?.repository ?? '')
        || !/^[a-f0-9]{40}$/.test(file.source?.commit ?? '') || !safePath(file.source?.path)) throw new Error('Supplement has no exact source or payload identity.');
    }
    if (item.surfaces.includes(surface)) {
      const owner = dependencies.find(value => value.path === item.packagePath);
      if (!owner || owner.name !== item.name || owner.version !== item.version) throw new Error('Unused or mismatched JavaScript notice supplement.');
      selected.set(item.packagePath, item);
    }
  }
  return selected;
}

/** Filesystem effects are bounded here; builders own final input-byte rechecks and writing. */
export async function collectJavaScriptNotices({ root, dependencies, lock, surface,
  readInput = (filename, _label, settings) => readRegularFile(filename, settings.maximumBytes) }) {
  if (!['app', 'worker'].includes(surface)) throw new Error('Unknown JavaScript notice surface.');
  const owners = checkedNoticeDependencies(dependencies, lock);
  const read = async path => {
    const bytes = await readInput(join(root, path), path, { maximumBytes: limits.fileBytes });
    if (bytes.length > limits.fileBytes) throw new Error('Notice input exceeds its byte limit.');
    return bytes;
  };
  const document = JSON.parse(await read('runtime/notices/javascript-supplements.json'));
  const supplements = supplementsFor(document, surface, owners, lock);
  const budget = { total: 0, package: 0 }; let totalBytes = 0;
  const snapshots = []; const payloads = []; const packages = [];
  const admit = bytes => {
    totalBytes += bytes.length;
    if (totalBytes > limits.totalBytes) throw new Error('JavaScript legal payloads exceed their total byte limit.');
    return bytes;
  };
  for (const [ownerIndex, owner] of owners.entries()) {
    budget.package = 0;
    const tree = await packageTree(root, owner.path, budget); snapshots.push(...tree.directories);
    const manifest = JSON.parse(await read(`${owner.path}/package.json`));
    if (manifest.name !== owner.name || manifest.version !== owner.version) throw new Error('Installed notice owner changed.');
    const pending = new Map(tree.files.filter(path => noticeKind(path)).map(path => [path, noticeKind(path)]));
    const references = []; const collected = new Map();
    if (typeof manifest.license === 'string' && /^SEE LICENSE IN /i.test(manifest.license)) {
      const target = localReference('package.json', manifest.license.slice(15).trim());
      if (!target) throw new Error('Package license requires a local text payload.');
      pending.set(target, 'license'); references.push({ from: 'package.json', target });
    }
    while (pending.size) {
      const [path, kind] = pending.entries().next().value; pending.delete(path);
      if (collected.has(path)) continue;
      if (!tree.files.includes(path)) throw new Error(`Unresolved local legal reference: ${owner.path}/${path}.`);
      const bytes = admit(await read(`${owner.path}/${path}`)); const text = legalText(bytes);
      collected.set(path, { sourcePath: path, kind, bytes });
      for (const target of noticeReferences(path, text)) {
        references.push({ from: path, target });
        if (!collected.has(target)) pending.set(target, noticeKind(target) ?? 'attribution');
      }
    }
    for (const [index, file] of (supplements.get(owner.path)?.files ?? []).entries()) {
      const bytes = admit(await read(file.path)); legalText(bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Supplement payload changed.');
      collected.set(`supplement/${index}`, { sourcePath: file.path, kind: file.kind, bytes, source: file.source });
    }
    if (![...collected.values()].some(file => file.kind === 'license')) throw new Error(`Missing license payload: ${owner.path}.`);
    const files = sorted(collected.keys()).map((key, fileIndex) => {
      const file = collected.get(key);
      const path = `files/${String(ownerIndex).padStart(4, '0')}/${String(fileIndex).padStart(4, '0')}.txt`;
      payloads.push({ path, bytes: file.bytes });
      return { path, sourcePath: file.sourcePath, kind: file.kind, bytes: file.bytes.length, sha256: hash(file.bytes), ...(file.source ? { source: file.source } : {}) };
    });
    packages.push({ ...owner, files, references: references.sort((a, b) => `${a.from}\0${a.target}` < `${b.from}\0${b.target}` ? -1 : 1) });
  }
  const evidence = [];
  if (!Array.isArray(document.evidence) || document.evidence.length > 32) throw new Error('Invalid supplement evidence inventory.');
  for (const entry of document.evidence) {
    if (!safePath(entry.path) || !entry.path.startsWith('runtime/notices/') || !sha256(entry.sha256)
      || !Array.isArray(entry.surfaces) || !entry.surfaces.length || entry.surfaces.some(value => !['app', 'worker'].includes(value))) throw new Error('Invalid supplement evidence.');
    if (!entry.surfaces.includes(surface)) continue;
    const bytes = admit(await read(entry.path)); legalText(bytes);
    if (hash(bytes) !== entry.sha256) throw new Error('Supplement evidence changed.');
    const path = `evidence/${String(evidence.length).padStart(4, '0')}.json`;
    JSON.parse(bytes); payloads.push({ path, bytes });
    evidence.push({ path, sourcePath: entry.path, sha256: entry.sha256, bytes: bytes.length });
  }
  const index = { schemaVersion: 1, surface, coverage: 'esbuild-package-owners', referenceSyntax: ['SEE LICENSE IN', 'local Markdown links'], evidence, packages };
  requireJavaScriptNoticeIndex(index, { surface, dependencies: owners });
  const verifyDirectories = async () => {
    const budget = { total: 0, package: 0 };
    for (const snapshot of snapshots) {
      budget.package = 0;
      if (!isDeepStrictEqual(await directorySnapshot(root, snapshot.path, budget), snapshot.entries)) throw new Error('JavaScript notice input directory changed.');
    }
  };
  return { index, files: [{ path: 'index.json', bytes: noticeIndexBytes(index) }, ...payloads], verifyDirectories };
}

export function requireJavaScriptNoticeIndex(value, { surface, dependencies }) {
  if (value?.schemaVersion !== 1 || value.surface !== surface || value.coverage !== 'esbuild-package-owners'
    || !Array.isArray(value.packages) || value.packages.length > limits.packages
    || !isDeepStrictEqual(value.packages.map(({ files: _files, references: _refs, ...owner }) => owner), dependencies)) throw new Error('JavaScript notice index differs from its package owners.');
  const paths = new Set(); let bytes = 0;
  if (!Array.isArray(value.evidence) || value.evidence.length > 32) throw new Error('Invalid supplement evidence index.');
  for (const file of value.evidence) {
    if (!/^evidence\/\d{4}\.json$/.test(file.path) || paths.has(file.path) || !safePath(file.sourcePath)
      || !sha256(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > limits.fileBytes
      || bytes + file.bytes > limits.totalBytes) throw new Error('Invalid supplement evidence index.');
    bytes += file.bytes; paths.add(file.path);
  }
  for (const owner of value.packages) {
    if (!Array.isArray(owner.files) || !owner.files.some(file => file.kind === 'license')) throw new Error('JavaScript notice index lacks a license payload.');
    for (const file of owner.files) {
      bytes += file.bytes;
      if (!/^files\/\d{4}\/\d{4}\.txt$/.test(file.path) || paths.has(file.path) || !safePath(file.sourcePath)
        || !kinds.has(file.kind) || !sha256(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || file.bytes > limits.fileBytes || bytes > limits.totalBytes) throw new Error('Invalid JavaScript notice payload index.');
      paths.add(file.path);
    }
    if (!Array.isArray(owner.references) || owner.references.some(ref => !safePath(ref.from) || !safePath(ref.target)
      || !owner.files.some(file => !file.source && file.sourcePath === ref.target))) throw new Error('Unresolved JavaScript notice reference.');
  }
  return value;
}

export function verifyJavaScriptNoticeArchive(index, entries, indexSha256) {
  const prefix = 'opt/rat-things/notices/javascript/';
  const expected = [{ path: 'index.json', sha256: indexSha256, bytes: noticeIndexBytes(index).length }, ...index.evidence, ...index.packages.flatMap(owner => owner.files)];
  const actual = entries.filter(entry => entry.path.startsWith(prefix) && (entry.mode & 0o170000) !== 0o040000);
  if (actual.length !== expected.length) throw new Error('Guest JavaScript notice membership differs.');
  for (const file of expected) {
    const member = actual.find(entry => entry.path === `${prefix}${file.path}`);
    if (!member || member.sha256 !== file.sha256 || member.bytes !== file.bytes || member.mode !== 0o100444
      || member.uid !== 0 || member.gid !== 0) throw new Error('Guest JavaScript notice bytes or permissions differ.');
  }
}
