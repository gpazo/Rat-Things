import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SHARE_REQUEST_FILE,
  appendSharedPublications,
  clearAgentShareRequest,
  MAX_AGENT_SHARE_REQUEST_BYTES,
  readAgentShareRequests,
} from '../../src/runner/publications.js';

describe('agent publication outbox', () => {
  it('parses explicit publication requests and appends the trusted links', async () => {
    const root = await workspace();
    try {
      await writeRequest(root, {
        version: '1',
        publications: [{
          version: '1',
          kind: 'site',
          root: 'site',
          entrypoint: 'index.html',
          title: 'Rat [Things]\nDemo',
        }],
      });
      const requests = await readAgentShareRequests(root);
      expect(requests).toEqual([{
        spec: {
          version: '1',
          kind: 'site',
          root: 'site',
          entrypoint: 'index.html',
          title: 'Rat [Things]\nDemo',
        },
        title: 'Rat [Things]\nDemo',
      }]);
      expect(appendSharedPublications('Done.', [{
        ...requests[0]!,
        descriptor: {
          publicationId: 'a'.repeat(24),
          kind: 'site',
          url: 'https://example.test/__share/token',
          expiresAt: '2026-08-16T12:00:00.000Z',
          entrypoint: 'index.html',
          paths: ['index.html'],
        },
      }])).toBe(
        'Done.\n\n## Shared work\n\n' +
        '- [Rat \\[Things\\] Demo](https://example.test/__share/token) — available until 2026-08-16T12:00:00.000Z\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no requests when absent and clears a stale persistent-turn request', async () => {
    const root = await workspace();
    try {
      await expect(readAgentShareRequests(root)).resolves.toEqual([]);
      await writeRequest(root, {
        version: '1',
        publications: [{ version: '1', kind: 'file', path: 'demo.txt' }],
      });
      await clearAgentShareRequest(root);
      await expect(readAgentShareRequests(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown fields, oversized input, symbolic links, and hard links', async () => {
    const root = await workspace();
    const outside = join(root, 'outside.json');
    try {
      await writeRequest(root, { version: '1', publications: [], extra: true });
      await expect(readAgentShareRequests(root)).rejects.toThrow('unknown field extra');

      await writeFile(join(root, AGENT_SHARE_REQUEST_FILE), Buffer.alloc(MAX_AGENT_SHARE_REQUEST_BYTES + 1));
      await expect(readAgentShareRequests(root)).rejects.toThrow('exceeds');

      await rm(join(root, AGENT_SHARE_REQUEST_FILE));
      await writeFile(outside, '{}');
      await symlink(outside, join(root, AGENT_SHARE_REQUEST_FILE));
      await expect(readAgentShareRequests(root)).rejects.toThrow('regular file');

      await rm(join(root, AGENT_SHARE_REQUEST_FILE));
      await link(outside, join(root, AGENT_SHARE_REQUEST_FILE));
      await expect(readAgentShareRequests(root)).rejects.toThrow('hard link');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rat-publications-'));
  await mkdir(join(root, '.rat-things'), { recursive: true });
  return root;
}

async function writeRequest(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, AGENT_SHARE_REQUEST_FILE), JSON.stringify(value));
}
