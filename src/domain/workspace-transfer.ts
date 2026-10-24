import { Zip, ZipDeflate } from 'fflate';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export interface PortableFile { path: string; data: string; mode: number; link?: string; directory?: boolean }
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

/** The read-only exporter runs inside the VM; the host receives only bounded workspace data. */
export const WORKSPACE_EXPORT_SCRIPT = `
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const files = []; let bytes = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir('/workspace/' + directory, { withFileTypes: true })) {
      const name = directory ? directory + '/' + entry.name : entry.name;
      if (name === '.rat-transfer') continue;
      const full = '/workspace/' + name;
      if (files.length >= 10000) throw new Error('Too many files');
      if (entry.isDirectory()) {
        files.push({ path: name, data: '', mode: (await fs.lstat(full)).mode & 511, directory: true });
        await walk(name);
      }
      else {
        if (files.length >= 10000) throw new Error('Too many files');
        const info = await fs.lstat(full);
        if (entry.isSymbolicLink()) {
          const link = await fs.readlink(full);
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
          if (link.startsWith('/') || target === '..' || target.startsWith('../')) throw new Error('Link leaves workspace');
          files.push({ path: name, data: '', mode: 511, link });
        } else if (entry.isFile()) {
          bytes += info.size;
          if (bytes > ${MAX_TRANSFER_BYTES}) throw new Error('Workspace exceeds transfer limit');
          files.push({ path: name, data: (await fs.readFile(full)).toString('base64'), mode: info.mode & 511 });
        } else throw new Error('Unsupported workspace file');
      }
    }
  }
  await walk(''); process.stdout.write(JSON.stringify(files));
})().catch(() => { process.stderr.write('Workspace export failed: limit or unsupported file.'); process.exitCode = 1; });`;

export function archiveWorkspace(files: PortableFile[]) {
  let bytes = 0;
  const paths = new Set<string>();
  const chunks: Uint8Array[] = [];
  let compressedBytes = 0;
  const zip = new Zip((error, data) => {
    if (error) throw error;
    compressedBytes += data.length;
    if (compressedBytes > 50 * 1024 * 1024) throw new Error('Compressed workspace exceeds the 50 MiB transfer limit');
    chunks.push(data);
  });
  if (files.length > 10_000) throw new Error('Workspace has too many files to transfer');
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.includes('\0') || file.path.split('/').some(part => !part || part === '..' || part === '.') || paths.has(file.path)) throw new Error('Invalid workspace archive path');
    if (file.path === '.rat-transfer' || file.path.startsWith('.rat-transfer/')) throw new Error('Reserved workspace archive path');
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Invalid workspace mode');
    if (file.directory && (file.link !== undefined || file.data !== '')) throw new Error('Invalid workspace directory');
    if (file.link !== undefined) {
      const target = posix.normalize(posix.join(posix.dirname(file.path), file.link));
      if (!file.link || file.link.startsWith('/') || file.link.includes('\0') || target === '..' || target.startsWith('../')) throw new Error('Link leaves workspace');
    } else if (Buffer.from(file.data, 'base64').toString('base64') !== file.data) throw new Error('Invalid workspace data');
    paths.add(file.path);
    const data = file.link === undefined ? Buffer.from(file.data, 'base64') : Buffer.from(file.link);
    bytes += data.length;
    if (bytes > MAX_TRANSFER_BYTES) throw new Error('Workspace exceeds the 100 MiB transfer limit');
    const entry = new ZipDeflate(file.directory ? `${file.path}/` : file.path, { level: 1 });
    entry.os = 3;
    entry.attrs = ((file.directory ? 0o40000 : file.link === undefined ? 0o100000 : 0o120000) | file.mode) << 16;
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  const archive = Buffer.concat(chunks);
  return { archive, sha256: createHash('sha256').update(archive).digest('hex'), files: files.length, bytes };
}

/** Fixed extraction program, run as the destination's non-root agent during admitted setup. */
export function restoreWorkspaceCommand(sha256: string, parts = 1): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid workspace digest');
  if (!Number.isInteger(parts) || parts < 1 || parts > 50) throw new Error('Invalid workspace parts');
  const script = `import hashlib, os, posixpath, stat, zipfile
p='/workspace/.rat-transfer/workspace.zip'
with open(p,'wb') as out:
 for j in range(${parts}):
  part='/workspace/.rat-transfer/part-'+str(j)
  with open(part,'rb') as f: out.write(f.read())
  os.remove(part)
assert hashlib.sha256(open(p,'rb').read()).hexdigest()=='${sha256}'
with zipfile.ZipFile(p) as z:
 entries=z.infolist()
 assert len(entries)<=10000 and sum(i.file_size for i in entries)<=${MAX_TRANSFER_BYTES}
 names=set(); directories=[]
 for i in entries:
  n=i.filename.rstrip('/') if i.is_dir() else i.filename
  assert n and not n.startswith('/') and '\\\\' not in n and all(v not in ('','.','..') for v in n.split('/')) and n not in names and not n.startswith('.rat-transfer/')
  names.add(n)
 for i in entries:
  n=i.filename.rstrip('/') if i.is_dir() else i.filename
  mode=i.external_attr>>16; target='/workspace/'+n
  parts=n.split('/')[:-1]; parent='/workspace'
  for part in parts:
   parent+='/'+part
   assert not os.path.islink(parent)
   os.makedirs(parent,exist_ok=True)
  assert not os.path.islink(target)
  data=z.read(i)
  if stat.S_ISDIR(mode):
   os.makedirs(target,exist_ok=True); directories.append((target,mode))
  elif stat.S_ISLNK(mode):
   link=data.decode(); resolved=posixpath.normpath(posixpath.join(posixpath.dirname(n),link))
   assert not link.startswith('/') and resolved!='..' and not resolved.startswith('../')
   os.symlink(link,target)
  else:
   assert stat.S_ISREG(mode)
   with open(target,'wb') as f: f.write(data)
   os.chmod(target,mode&0o777)
 for target,mode in reversed(directories): os.chmod(target,mode&0o777)
os.remove(p)`;
  return `python3 -c '${script.replaceAll("'", "'\\''")}'`;
}
