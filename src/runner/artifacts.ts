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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactStore } from '../core/ports.js';
import {
  MAX_ARTIFACT_FILES,
  validateArtifactCatalog,
  validateArtifactPath,
} from '../domain/artifacts.js';
import type {
  ArtifactCatalog,
  PublishedArtifact,
} from '../domain/contracts.js';
import {
  AGENT_ARTIFACT_DIRECTORY,
  artifactByteTotal,
  artifactFileIdentity,
  artifactOwnerHash,
  artifactPromptText,
  completeArtifactPublication,
  detectMediaType,
  planArtifactPublication,
} from './artifact-planning.js';

export {
  AGENT_ARTIFACT_DIRECTORY,
  assertArtifactCatalogScope,
  emptyArtifactCatalog,
} from './artifact-planning.js';

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
  await mkdir(root, { recursive: true, mode: 0o700 });
  await clearDirectoryContents(root);
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
  const reusableBlobs = new Map(
    input.previous.files.map((file) => [file.file.sha256, file.file]),
  );
  const ownerHash = artifactOwnerHash(input.ownerId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const published: PublishedArtifact[] = [];
  let totalBytes = 0;

  for (const path of paths) {
    const absolute = artifactPath(root, path);
    const stat = await lstat(absolute);
    totalBytes = artifactByteTotal(path, {
      regular: stat.isFile(), links: stat.nlink, size: stat.size,
    }, totalBytes);
    const sample = await readSample(absolute);
    const existing = previous.get(path);
    const detectedMediaType = detectMediaType(sample, path);
    const digest = await sha256File(absolute);
    const reusable = reusableBlobs.get(digest);
    const plan = planArtifactPublication({
      ownerHash, path, bytes: stat.size, digest, mediaType: detectedMediaType,
      ...(existing ? { previous: existing } : {}),
      ...(reusable ? { reusable } : {}),
    });
    const file = plan.kind === 'upload'
      ? await input.artifacts.putStream(plan.key, createReadStream(absolute), detectedMediaType)
      : await input.artifacts.copy(plan.source, plan.key, detectedMediaType);
    published.push(completeArtifactPublication(plan, file, input.runId, createdAt));
    reusableBlobs.set(digest, file);
  }
  return published.sort((left, right) => left.path.localeCompare(right.path));
}

export async function localArtifactPaths(workspace: string): Promise<string[]> {
  return listArtifactPaths(await prepareArtifactDirectory(workspace));
}

/** Clears exported bytes without removing the directory, which may be a bind mount. */
export async function clearArtifactDirectory(workspace: string): Promise<void> {
  const root = await prepareArtifactDirectory(workspace);
  await clearDirectoryContents(root);
}

export function artifactPrompt(
  prompt: string,
  publicationEnabled = process.env.AGENT_PUBLICATION_ENABLED === 'true',
): string {
  return artifactPromptText(prompt, publicationEnabled);
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

async function clearDirectoryContents(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
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
  return artifactFileIdentity(process.env.RUN_AGENT_UID, process.env.RUN_AGENT_GID);
}
