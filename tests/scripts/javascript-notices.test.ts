import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectJavaScriptNotices, noticeIndexBytes, noticeKind, noticeReferences, requireJavaScriptNoticeIndex, verifyJavaScriptNoticeArchive } from '../../scripts/javascript-notices.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(files: Record<string, string | Uint8Array> = { LICENSE: 'Original license\r\n' }, license = 'MIT') {
  const root = await mkdtemp(join(tmpdir(), 'rat-javascript-notices-')); roots.push(root);
  const write = async (path: string, bytes: Uint8Array | string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); };
  const dependency = { path: 'node_modules/example', name: 'example', version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-fixture', license };
  const lock = { packages: { [dependency.path]: dependency } };
  await write('runtime/notices/javascript-supplements.json', JSON.stringify({ schemaVersion: 1, packages: [], evidence: [] }));
  await write('node_modules/example/package.json', JSON.stringify({ name: 'example', version: '1.0.0', license }));
  for (const [path, bytes] of Object.entries(files)) await write(`node_modules/example/${path}`, bytes);
  const collect = (dependencies = [dependency]) => collectJavaScriptNotices({ root, dependencies, lock, surface: 'app' });
  return { root, write, dependency, lock, collect };
}

it('preserves original bytes, nested vendored texts, and attribution alongside the license', async () => {
  const f = await fixture({ LICENSE: 'Original license\r\n', 'src/_vendor/parser/LICENSE': 'Vendor license', NOTICE: 'Attribution',
    'lib/fetch/LICENSE': 'Nested license', 'CopyrightNotice.txt': 'Copyright', 'node_modules/other/LICENSE': 'Other owner' });
  const result = await f.collect();
  expect(result.index.packages[0].files.map((file: { sourcePath: string }) => file.sourcePath)).toEqual(['CopyrightNotice.txt', 'LICENSE', 'NOTICE', 'lib/fetch/LICENSE', 'src/_vendor/parser/LICENSE']);
  expect(result.files.find((file: { path: string }) => file.path === result.index.packages[0].files.find((file: { sourcePath: string }) => file.sourcePath === 'LICENSE').path)!.bytes).toEqual(Buffer.from('Original license\r\n'));
  expect(result.files).toEqual((await f.collect()).files);
  await result.verifyDirectories();
});

it('follows explicit license metadata and local legal links without fetching web links', async () => {
  const f = await fixture({ 'terms/terms.txt': '[Attribution](../credit.txt) [Website](https://example.invalid/legal)', 'credit.txt': 'Authors' }, 'SEE LICENSE IN terms/terms.txt');
  const result = await f.collect();
  expect(result.index.packages[0].references).toEqual([{ from: 'package.json', target: 'terms/terms.txt' }, { from: 'terms/terms.txt', target: 'credit.txt' }]);
  expect(result.index.packages[0].files.some((file: { kind: string; sourcePath: string }) => file.kind === 'license' && file.sourcePath === 'terms/terms.txt')).toBe(true);
  expect(() => noticeReferences('LICENSE', '[outside](../secret)')).toThrow('escapes');
  expect(noticeKind('NOTICE')).toBe('attribution');
});

it.each([{ NOTICE: 'Notice without license' }, { LICENSE: '[Missing](missing.txt)' }])('fails when license text or referenced text is absent: %j', async files => {
  const f = await fixture(files);
  await expect(f.collect()).rejects.toThrow(/Missing license|Unresolved local/);
});

it('rejects stale dependency identity before collecting notices', async () => {
  const f = await fixture();
  await expect(f.collect([{ ...f.dependency, version: '2.0.0' }])).rejects.toThrow('dependency lock');
  await f.write('node_modules/example/package.json', JSON.stringify({ name: 'different', version: '1.0.0' }));
  await expect(f.collect()).rejects.toThrow('owner changed');
});

it('rejects symlink inputs and oversized or binary legal payloads', async () => {
  const f = await fixture();
  await symlink('/private/tmp', join(f.root, 'node_modules/example/link'));
  await expect(f.collect()).rejects.toThrow('symlinks');
  await rm(join(f.root, 'node_modules/example/link'));
  await f.write('node_modules/example/LICENSE', Buffer.alloc(1024 ** 2 + 1, 65));
  await expect(f.collect()).rejects.toThrow('byte limit');
  await f.write('node_modules/example/LICENSE', Buffer.from([0, 1]));
  await expect(f.collect()).rejects.toThrow('UTF-8');
});

it.each(['add', 'remove', 'symlink'] as const)('detects directory %s after collection', async change => {
  const f = await fixture(); const result = await f.collect();
  if (change === 'add') await f.write('node_modules/example/NOTICE', 'new notice');
  else if (change === 'remove') await rm(join(f.root, 'node_modules/example/LICENSE'));
  else { await rm(join(f.root, 'node_modules/example/LICENSE')); await symlink('/private/tmp', join(f.root, 'node_modules/example/LICENSE')); }
  await expect(result.verifyDirectories()).rejects.toThrow(/changed|symlinks/);
});

it('requires exact reviewed supplemental bytes and rejects stale or unused supplements', async () => {
  const f = await fixture({ NOTICE: 'Publisher attribution' });
  const bytes = Buffer.from('Exact upstream license\r\n');
  const supplemental = { packagePath: f.dependency.path, name: f.dependency.name, version: f.dependency.version, integrity: f.dependency.integrity, surfaces: ['app'],
    files: [{ path: 'runtime/notices/upstream/LICENSE', bytes: bytes.length, sha256: hash(bytes), kind: 'license', source: { repository: 'https://github.com/example/project', commit: 'a'.repeat(40), path: 'LICENSE' } }] };
  await f.write('runtime/notices/upstream/LICENSE', bytes);
  const writeSupplement = () => f.write('runtime/notices/javascript-supplements.json', JSON.stringify({ schemaVersion: 1, packages: [supplemental], evidence: [] }));
  await writeSupplement();
  const result = await f.collect(); expect(result.files.some((file: { bytes: Buffer }) => file.bytes.equals(bytes))).toBe(true);
  await expect(f.collect([])).rejects.toThrow('Unused');
  supplemental.version = '2.0.0'; await writeSupplement(); await expect(f.collect()).rejects.toThrow('Stale');
  supplemental.version = '1.0.0'; await writeSupplement(); await f.write('runtime/notices/upstream/LICENSE', 'Changed');
  await expect(f.collect()).rejects.toThrow('payload changed');
});

it('binds every legal input through the builders read adapter', async () => {
  const f = await fixture({ LICENSE: 'License', 'src/vendor/NOTICE': 'Notice' }); const tracked: string[] = [];
  await collectJavaScriptNotices({ root: f.root, dependencies: [f.dependency], lock: f.lock, surface: 'app', readInput: async (path: string, label: string) => { tracked.push(label); return readFile(path); } });
  expect(tracked).toEqual(['runtime/notices/javascript-supplements.json', 'node_modules/example/package.json', 'node_modules/example/LICENSE', 'node_modules/example/src/vendor/NOTICE']);
});

it('stops reading legal inputs as soon as their combined payload exceeds the cap', async () => {
  const files = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`LICENSE-${String(i).padStart(2, '0')}`, Buffer.alloc(1024 ** 2, 65)]));
  const f = await fixture(files); const read: string[] = [];
  await expect(collectJavaScriptNotices({ root: f.root, dependencies: [f.dependency], lock: f.lock, surface: 'app',
    readInput: async (path: string, label: string) => { read.push(label); return readFile(path); } })).rejects.toThrow('total byte limit');
  expect(read.filter(path => path.includes('/LICENSE-'))).toHaveLength(17);
  expect(read.some(path => path.endsWith('LICENSE-17'))).toBe(false);
});

it('includes supplement evidence in the combined payload cap even without package owners', async () => {
  const f = await fixture({}); const bytes = Buffer.from('"' + 'a'.repeat(1024 ** 2 - 2) + '"');
  await f.write('runtime/notices/evidence.json', bytes);
  const evidence = Array.from({ length: 17 }, () => ({ path: 'runtime/notices/evidence.json', sha256: hash(bytes), surfaces: ['worker'] }));
  await f.write('runtime/notices/javascript-supplements.json', JSON.stringify({ schemaVersion: 1, packages: [], evidence }));
  await expect(collectJavaScriptNotices({ root: f.root, dependencies: [], lock: f.lock, surface: 'worker' })).rejects.toThrow('total byte limit');
  const index = { schemaVersion: 1, surface: 'worker', coverage: 'esbuild-package-owners', packages: [],
    evidence: evidence.map((entry, i) => ({ path: `evidence/${String(i).padStart(4, '0')}.json`, sourcePath: entry.path, bytes: bytes.length, sha256: entry.sha256 })) };
  expect(() => requireJavaScriptNoticeIndex(index, { surface: 'worker', dependencies: [] })).toThrow('evidence index');
});

it('admits exact guest notice membership, hashes, size and mode', async () => {
  const f = await fixture(); const { index, files } = await f.collect();
  const entries = files.map((file: { path: string; bytes: Buffer }) => ({ path: 'opt/rat-things/notices/javascript/' + file.path, bytes: file.bytes.length, sha256: hash(file.bytes), uid: 0, gid: 0, mode: 0o100444 }));
  const digest = hash(noticeIndexBytes(index));
  expect(() => verifyJavaScriptNoticeArchive(index, entries, digest)).not.toThrow();
  expect(() => verifyJavaScriptNoticeArchive(index, entries.slice(1), digest)).toThrow('membership');
  for (const patch of [{ sha256: 'a'.repeat(64) }, { bytes: 1 }, { mode: 0o100644 }, { uid: 10001 }]) {
    expect(() => verifyJavaScriptNoticeArchive(index, [{ ...entries[0]!, ...patch }, ...entries.slice(1)], digest)).toThrow('permissions');
  }
});
