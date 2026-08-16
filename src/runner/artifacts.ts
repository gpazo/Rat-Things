import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactStore } from '../core/ports.js';
import {
  artifactIdForPath,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  validateArtifactCatalog,
  validateArtifactPath,
} from '../domain/artifacts.js';
import type {
  ArtifactCatalog,
  PublishedArtifact,
} from '../domain/contracts.js';

export const AGENT_ARTIFACT_DIRECTORY = '.rat-things/artifacts';

export async function prepareArtifactDirectory(workspace: string): Promise<string> {
  const control = controlRoot(workspace);
  await mkdir(control, { recursive: true, mode: 0o700 });
  await handoff(control);
  const root = artifactRoot(workspace);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await handoff(root);
  return root;
}

/** Rebuilds the agent-visible directory from the durable, trusted catalog. */
export async function restoreArtifactCatalog(
  workspace: string,
  catalog: ArtifactCatalog,
  artifacts: Pick<ArtifactStore, 'getStream'>,
): Promise<void> {
  validateArtifactCatalog(catalog);
  const control = controlRoot(workspace);
  await mkdir(control, { recursive: true, mode: 0o700 });
  await handoff(control);
  const root = artifactRoot(workspace);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const published of catalog.files) {
    const target = artifactPath(root, published.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.rat-restore-${randomUUID()}`;
    const digest = createHash('sha256');
    const checksum = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      const source = await artifacts.getStream(published.file);
      await pipeline(
        Readable.from(source),
        checksum,
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (digest.digest('hex') !== published.file.sha256) {
        throw new Error(`durable artifact ${published.id} failed its checksum`);
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  await handoffTree(root);
}

/**
 * Validates and republishes the complete current outbox. Republishing renews
 * object lifecycle with the conversation while preserving last-change metadata.
 */
export async function publishArtifactCatalog(input: {
  workspace: string;
  previous: ArtifactCatalog;
  artifacts: Pick<ArtifactStore, 'copy' | 'putStream'>;
  ownerId: string;
  runId: string;
  createdAt?: string;
}): Promise<PublishedArtifact[]> {
  validateArtifactCatalog(input.previous);
  const root = await prepareArtifactDirectory(input.workspace);
  const paths = await listArtifactPaths(root);
  if (paths.length > MAX_ARTIFACT_FILES) {
    throw new Error(`artifact directory exceeds ${MAX_ARTIFACT_FILES} files`);
  }
  const previous = new Map(input.previous.files.map((file) => [file.path, file]));
  const ownerHash = sha256(Buffer.from(input.ownerId)).slice(0, 32);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const published: PublishedArtifact[] = [];
  let totalBytes = 0;

  for (const path of paths) {
    const absolute = artifactPath(root, path);
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error(`artifact ${path} is not a regular file`);
    if (stat.nlink !== 1) throw new Error(`artifact ${path} cannot be a hard link`);
    if (stat.size > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error(`artifact ${path} exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error(`artifact directory exceeds ${MAX_ARTIFACT_TOTAL_BYTES} bytes`);
    }
    const sample = await readSample(absolute);
    const existing = previous.get(path);
    const id = artifactIdForPath(path);
    const detectedMediaType = detectMediaType(sample, path);
    const key = `owners/${ownerHash}/runs/${input.runId}/artifacts/${id}/${encodeURIComponent(basename(path))}`;
    const digest = await sha256File(absolute);
    const unchanged = existing?.bytes === stat.size && existing.file.sha256 === digest;
    const file = unchanged
      ? await input.artifacts.copy(existing.file, key, detectedMediaType)
      : await input.artifacts.putStream(key, createReadStream(absolute), detectedMediaType);
    if (file.sha256 !== digest) {
      throw new Error(`artifact ${path} changed while it was being published`);
    }
    published.push(unchanged
      ? { ...existing, file }
      : {
          id,
          path,
          mediaType: detectedMediaType,
          bytes: stat.size,
          createdAt,
          sourceRunId: input.runId,
          file,
        });
  }
  return published.sort((left, right) => left.path.localeCompare(right.path));
}

export async function localArtifactPaths(workspace: string): Promise<string[]> {
  return listArtifactPaths(await prepareArtifactDirectory(workspace));
}

export function artifactPrompt(
  prompt: string,
  publicationEnabled = process.env.AGENT_PUBLICATION_ENABLED === 'true',
): string {
  const instructions = [
    'Rat Things files:',
    `- Files available to this session are under ${AGENT_ARTIFACT_DIRECTORY}/.`,
    `- When write access is enabled, return or preserve a file by writing it under ${AGENT_ARTIFACT_DIRECTORY}/ using a clear relative filename.`,
    '- Managed runs catalog files after a successful turn; durable conversations restore them when they resume, even in a replacement MicroVM.',
    '- Mention the relative filename in your response. Do not create credentials or secrets there.',
  ];
  if (publicationEnabled) {
    instructions.push(
      'Rat Things sharing:',
      '- When the user asks you to share finished work, write .rat-things/share.json in addition to the files under .rat-things/artifacts/.',
      '- Use exactly {"version":"1","publications":[...]} where each publication is one of: {"version":"1","kind":"site","root":"site","entrypoint":"index.html","title":"Title"}, {"version":"1","kind":"file","path":"file.ext","title":"Title"}, or {"version":"1","kind":"video","path":"video.mp4","poster":"poster.jpg","title":"Title"}. Omit optional fields you do not need.',
      '- Publication paths are relative to .rat-things/artifacts/. The trusted runner publishes them and appends the real share links to your response. Never invent or guess a share URL.',
    );
  }
  return [...instructions, 'User request:', prompt].join('\n\n');
}

export function emptyArtifactCatalog(): ArtifactCatalog {
  return { version: '1', files: [] };
}

export function assertArtifactCatalogScope(
  catalog: ArtifactCatalog,
  bucket: string,
  ownerId: string,
): void {
  validateArtifactCatalog(catalog);
  const prefix = `owners/${sha256(Buffer.from(ownerId)).slice(0, 32)}/runs/`;
  for (const artifact of catalog.files) {
    if (artifact.file.bucket !== bucket || !artifact.file.key.startsWith(prefix)) {
      throw new Error(`artifact ${artifact.id} is outside its owner scope`);
    }
  }
}

function artifactRoot(workspace: string): string {
  return resolve(workspace, AGENT_ARTIFACT_DIRECTORY);
}

function controlRoot(workspace: string): string {
  return resolve(workspace, '.rat-things');
}

function artifactPath(root: string, path: string): string {
  validateArtifactPath(path);
  const target = resolve(root, ...path.split('/'));
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`artifact path ${JSON.stringify(path)} escapes its directory`);
  }
  return target;
}

async function listArtifactPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      validateArtifactPath(path);
      if (entry.isSymbolicLink()) throw new Error(`artifact ${path} cannot be a symbolic link`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        paths.push(path);
        if (paths.length > MAX_ARTIFACT_FILES) return;
      } else {
        throw new Error(`artifact ${path} is not a regular file`);
      }
    }
  };
  await visit(root);
  return paths.sort();
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function detectMediaType(bytes: Uint8Array, path: string): string {
  const value = Buffer.from(bytes);
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
  if (value.subarray(0, 6).toString('ascii') === 'GIF87a' || value.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (value.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = value.subarray(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (extension === 'm4a' || extension === 'm4b') return 'audio/mp4';
    if (extension === 'mov') return 'video/quicktime';
    return 'video/mp4';
  }
  if (value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (value.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (value.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (value.subarray(0, 4).toString('ascii') === 'OggS') {
    return extension === 'ogv' ? 'video/ogg' : 'audio/ogg';
  }
  const textual: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json',
    m3u8: 'application/vnd.apple.mpegurl',
    md: 'text/markdown; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
    webmanifest: 'application/manifest+json',
    xml: 'application/xml',
  };
  if (extension && textual[extension] && !value.includes(0)) return textual[extension];
  const binary: Record<string, string> = {
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    ogv: 'video/ogg',
    opus: 'audio/ogg',
    wasm: 'application/wasm',
    wav: 'audio/wav',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  if (extension && binary[extension]) return binary[extension];
  return 'application/octet-stream';
}

async function readSample(path: string, maximum = 8_192): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function handoffTree(root: string): Promise<void> {
  const identity = configuredAgentIdentity();
  if (!identity) return;
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    }
    await chown(path, identity.uid, identity.gid);
  };
  await visit(root);
}

async function handoff(path: string): Promise<void> {
  const identity = configuredAgentIdentity();
  if (identity) await chown(path, identity.uid, identity.gid);
}

function configuredAgentIdentity(): { uid: number; gid: number } | undefined {
  const rawUid = process.env.RUN_AGENT_UID;
  const rawGid = process.env.RUN_AGENT_GID;
  if (!rawUid && !rawGid) return undefined;
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new Error('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
  }
  return { uid, gid };
}
