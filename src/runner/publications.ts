import { lstat, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PublicationDescriptor, PublicationSpec } from '../domain/publications.js';
import { parsePublicationSpec } from '../domain/publications.js';

export const AGENT_SHARE_REQUEST_FILE = '.rat-things/share.json';
export const MAX_AGENT_SHARE_REQUEST_BYTES = 32_768;
export const MAX_AGENT_PUBLICATIONS = 10;

export interface RequestedPublication {
  spec: PublicationSpec;
  title?: string;
}

export interface SharedPublication extends RequestedPublication {
  descriptor: PublicationDescriptor;
}

/** Prevents a request from an earlier persistent turn from being replayed. */
export async function clearAgentShareRequest(workspace: string): Promise<void> {
  await rm(shareRequestPath(workspace), { force: true });
}

/** Reads the untrusted agent outbox with strict shape and filesystem checks. */
export async function readAgentShareRequests(workspace: string): Promise<RequestedPublication[]> {
  const path = shareRequestPath(workspace);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} must be a regular file`);
  }
  if (stat.nlink !== 1) throw new Error(`${AGENT_SHARE_REQUEST_FILE} cannot be a hard link`);
  if (stat.size > MAX_AGENT_SHARE_REQUEST_BYTES) {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} exceeds ${MAX_AGENT_SHARE_REQUEST_BYTES} bytes`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== stat.size) {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} changed while it was being read`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} must contain valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${AGENT_SHARE_REQUEST_FILE} must contain an object`);
  const unknown = Object.keys(value).find((key) => !['version', 'publications'].includes(key));
  if (unknown) throw new Error(`${AGENT_SHARE_REQUEST_FILE} contains unknown field ${unknown}`);
  if (value.version !== '1') throw new Error(`${AGENT_SHARE_REQUEST_FILE} version must be "1"`);
  if (!Array.isArray(value.publications)) {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} publications must be an array`);
  }
  if (value.publications.length === 0 || value.publications.length > MAX_AGENT_PUBLICATIONS) {
    throw new Error(`${AGENT_SHARE_REQUEST_FILE} must request 1-${MAX_AGENT_PUBLICATIONS} publications`);
  }
  return value.publications.map((entry) => {
    const spec = parsePublicationSpec(entry);
    return { spec, ...(spec.title ? { title: spec.title } : {}) };
  });
}

export function appendSharedPublications(
  output: string,
  publications: readonly SharedPublication[],
): string {
  if (publications.length === 0) return output;
  const links = publications.map(({ descriptor, title }) => {
    const label = markdownLabel(title ?? defaultTitle(descriptor.kind));
    return `- [${label}](${descriptor.url}) — available until ${descriptor.expiresAt}`;
  });
  return `${output.trimEnd()}\n\n## Shared work\n\n${links.join('\n')}\n`;
}

function shareRequestPath(workspace: string): string {
  return resolve(workspace, AGENT_SHARE_REQUEST_FILE);
}

function defaultTitle(kind: PublicationDescriptor['kind']): string {
  if (kind === 'site') return 'Open the website';
  if (kind === 'video') return 'Watch the video';
  return 'Open the file';
}

function markdownLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/([\\[\]])/g, '\\$1').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
