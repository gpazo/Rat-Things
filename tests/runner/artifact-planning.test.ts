import { describe, expect, it } from 'vitest';
import { detectMediaType } from '../../src/domain/media-type.js';
import { artifactPromptText } from '../../src/runner/artifact-planning.js';
import { agentProcessIdentity } from '../../src/runner/agent-identity.js';

describe('artifact content values', () => {
  it('prioritizes content signatures over misleading extensions without changing the sample', () => {
    const sample = Buffer.from('%PDF-sample');
    const before = Buffer.from(sample);
    expect(detectMediaType(sample, 'misleading.png')).toBe('application/pdf');
    expect(sample).toEqual(before);
    expect(detectMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image.txt')).toBe('image/png');
  });

  it.each([
    ['asset.avif', 'avif', 'image/avif'],
    ['asset.M4A', 'isom', 'audio/mp4'],
    ['asset.mov', 'isom', 'video/quicktime'],
    ['asset.bin', 'isom', 'video/mp4'],
  ])('uses the container brand and extension for %s', (path, brand, expected) => {
    expect(detectMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${brand}`)]), path)).toBe(expected);
  });

  it('rejects text classification for NUL samples and preserves empty-file extension detection', () => {
    expect(detectMediaType(Buffer.from([0]), 'index.html')).toBe('application/octet-stream');
    expect(detectMediaType(new Uint8Array(), 'index.HTML')).toBe('text/html; charset=utf-8');
    expect(detectMediaType(Buffer.from([0]), 'module.wasm')).toBe('application/wasm');
    expect(detectMediaType(Buffer.from('OggS'), 'movie.ogv')).toBe('video/ogg');
    expect(detectMediaType(Buffer.from('OggS'), 'audio.bin')).toBe('audio/ogg');
    expect(detectMediaType(Buffer.from('unknown'), 'unknown.bin')).toBe('application/octet-stream');
  });

  it('builds file instructions while preserving empty and whitespace requests', () => {
    expect(artifactPromptText('')).toMatch(/User request:\n\n$/);
    expect(artifactPromptText('  request\n')).toMatch(/User request:\n\n  request\n$/);
    expect(artifactPromptText('request')).not.toContain('share.json');
  });

  it('parses explicit file-ownership settings with the existing numeric coercion rules', () => {
    expect(agentProcessIdentity(undefined, undefined)).toBeUndefined();
    expect(agentProcessIdentity('', '')).toBeUndefined();
    expect(agentProcessIdentity('0x64', ' 101 ')).toEqual({ uid: 100, gid: 101 });
    for (const [uid, gid] of [['0', '1'], ['1', ''], ['1.5', '2'], ['invalid', '2'], ['1', undefined]]) {
      expect(() => agentProcessIdentity(uid, gid)).toThrow('must both be positive integers');
    }
  });
});
