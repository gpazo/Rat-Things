import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { hashFile, regularInventory } from './prepare.js';

function newc(name: string, bytes: Buffer, mode: number) {
  const filename = Buffer.from(`${name}\0`);
  const fields = [1, mode, 0, 0, 1, 0, bytes.length, 0, 0, 0, 0, filename.length, 0];
  const header = Buffer.from(`070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}`);
  return Buffer.concat([header, filename, Buffer.alloc((4 - (header.length + filename.length) % 4) % 4), bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
}

/** A test-only guest overlay breaks bundled bwrap. The source assets are never modified. */
export async function sandboxRefusalVariant(source: string, evidenceDirectory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
    version: number; target: string; kernelSha256: string; initrdSha256: string; helperSha256: string; files: { path: string; sha256: string }[];
  };
  assert.equal(manifest.version, 1); assert.equal(manifest.target, 'x86_64-unknown-linux-gnu');
  const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  const actual = (await regularInventory(join(source, 'qemu'))).map(file => ({ ...file, path: `qemu/${file.path}` })).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(actual, expected, 'Negative fixture requires an intact source QEMU inventory');
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(evidenceDirectory, 'sandbox-refusal-assets-'));
  const files = [...manifest.files, { path: 'Image', sha256: manifest.kernelSha256 }, { path: 'worker-initramfs.gz', sha256: manifest.initrdSha256 }, { path: 'rat-linux-worker', sha256: manifest.helperSha256 }];
  for (const file of files) {
    assert(!file.path.startsWith('/') && !file.path.includes('\\') && !file.path.split('/').some(part => ['.', '..', ''].includes(part)), 'Invalid fixture source path');
    const from = join(source, file.path), to = join(output, file.path), info = await lstat(from);
    assert(info.isFile()); assert.equal(await hashFile(from), file.sha256);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    assert.equal(await hashFile(to), file.sha256, 'Fixture source changed while being copied');
    await chmod(to, info.mode & 0o111 ? 0o700 : 0o600);
  }
  const replacement = Buffer.from('#!/bin/sh\nprintf "RAT_SANDBOX_REFUSAL_FIXTURE\\n" >&2\nexit 97\n');
  await appendFile(join(output, 'worker-initramfs.gz'), gzipSync(Buffer.concat([
    newc('opt/codex-runtime/codex-resources/bwrap', replacement, 0o100755), newc('TRAILER!!!', Buffer.alloc(0), 0),
  ])));
  const changed = { ...manifest, initrdSha256: await hashFile(join(output, 'worker-initramfs.gz')) };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(changed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'negative-fixture.json'), JSON.stringify({ purpose: 'Deliberately broken bwrap: startup must refuse before model dispatch',
    sourceManifestSha256: await hashFile(join(source, 'manifest.json')), sourceInitrdSha256: manifest.initrdSha256, changedInitrdSha256: changed.initrdSha256,
    replacedGuestFile: '/opt/codex-runtime/codex-resources/bwrap', expectedSerialMessage: 'Local worker failed during setup.' }, null, 2) + '\n', { mode: 0o600 });
  return output;
}
