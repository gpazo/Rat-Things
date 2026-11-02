import { createOutputRedactor } from '../../src/core/output-redactor.js';
import { expect, it } from 'vitest';
import { redactOutput, redactText, secretRedactionPatterns } from '../../src/domain/output-redaction.js';
import { CredentialResponseScrubber } from '../../src/runner/credential-response.js';
import { Readable } from 'node:stream';

const secret = 'private-☃-token/$&+123';
const patterns = secretRedactionPatterns([{ secret, replacement: 'rat_placeholder' }]);

it('redacts raw and encoded values without changing unrelated data or input ownership', () => {
  const original = { items: [{ text: `a ${secret} b ${Buffer.from(secret).toString('base64')} c ${encodeURIComponent(secret)}` }], status: 'completed', count: 0 };
  const before = structuredClone(original);
  expect(redactOutput(original, patterns)).toEqual({ value: { ...original, items: [{ text: 'a rat_placeholder b rat_placeholder c rat_placeholder' }] }, count: 3 });
  expect(original).toEqual(before);
  expect(redactText('ordinary content', patterns)).toEqual({ value: 'ordinary content', count: 0 });
  expect(secretRedactionPatterns([{ secret: 'short', replacement: 'hidden' }])).toEqual([]);
});

it('scrubs arbitrary byte and UTF-8 chunk boundaries while preserving binary bytes', async () => {
  const input = Buffer.concat([Buffer.from([0xff, 0, 0x01]), Buffer.from(`${secret}|${Buffer.from(secret).toString('base64')}|${encodeURIComponent(secret)}|tail`)]);
  for (const size of [1, 3, 17, 65536]) {
    let count = 0;
    const stream = new CredentialResponseScrubber(patterns, value => { count += value; });
    const chunks = Array.from({ length: Math.ceil(input.length / size) }, (_, index) => input.subarray(index * size, (index + 1) * size));
    const output: Buffer[] = [];
    for await (const chunk of Readable.from(chunks).pipe(stream)) output.push(Buffer.from(chunk));
    expect(Buffer.concat(output)).toEqual(Buffer.concat([Buffer.from([0xff, 0, 0x01]), Buffer.from('rat_placeholder|rat_placeholder|rat_placeholder|tail')]));
    expect(count).toBe(3);
  }
});

it('handles overlapping secrets without rescanning replacements', async () => {
  const overlapping = secretRedactionPatterns([{ secret: 'abcdefgh', replacement: 'abcdefgh-long' }, { secret: 'abcdefgh-long', replacement: 'second' }]);
  const stream = Readable.from([Buffer.from('xxabcdefgh-'), Buffer.from('longyyabcdefgh')]).pipe(new CredentialResponseScrubber(overlapping, () => {}));
  const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('xxsecondyyabcdefgh-long');
});

it('retains old and rotated host credentials without putting the registry into output', () => {
  const redact = createOutputRedactor(['original-private-token']);
  redact.remember(['rotated-private-token']);
  expect(redact({ text: 'original-private-token rotated-private-token' })).toEqual({ text: '[REDACTED] [REDACTED]' });
  expect(JSON.stringify(redact)).toBeUndefined();
});

it('scrubs arbitrary JSON keys without losing entries when redacted names collide', () => {
  const redact = createOutputRedactor(['planted-private-token'], { keys: true });
  const result = redact({ 'planted-private-token': 'first', '[REDACTED]': 'second' });
  expect(JSON.stringify(result)).not.toContain('planted-private-token');
  expect(Object.values(result)).toEqual(['first', 'second']);
});
