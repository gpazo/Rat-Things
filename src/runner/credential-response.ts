import { Transform, type TransformCallback } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { RedactionPattern } from '../domain/output-redaction.js';

export function credentialResponseDecoder(encoding: string | undefined): Transform | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case undefined: case '': case 'identity': return undefined;
    case 'gzip': return createGunzip();
    case 'deflate': return createInflate();
    case 'br': return createBrotliDecompress();
    default: throw new Error('Unsupported authenticated response encoding');
  }
}

export class CredentialResponseScrubber extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private readonly patterns: Array<{ value: Buffer; replacement: Buffer }>;
  private readonly retain: number;
  public constructor(patterns: readonly RedactionPattern[], private readonly scrubbed: (count: number) => void) {
    super();
    this.patterns = patterns.map(({ value, replacement }) => ({ value: Buffer.from(value), replacement: Buffer.from(replacement) })).sort((a, b) => b.value.length - a.value.length);
    this.retain = Math.max(1, ...this.patterns.map(pattern => pattern.value.length)) - 1;
  }
  public override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.scan(Buffer.concat([this.pending, chunk]), false); done();
  }
  public override _flush(done: TransformCallback): void { this.scan(this.pending, true); done(); }
  private scan(input: Buffer, final: boolean): void {
    const limit = final ? input.length : Math.max(0, input.length - this.retain);
    let offset = 0;
    let copied = 0;
    let count = 0;
    while (offset < limit) {
      const match = this.patterns.find(pattern => input.subarray(offset, offset + pattern.value.length).equals(pattern.value));
      if (!match) { offset++; continue; }
      if (offset > copied) this.push(input.subarray(copied, offset));
      this.push(match.replacement); offset += match.value.length; copied = offset; count++;
    }
    if (offset > copied) this.push(input.subarray(copied, offset));
    this.pending = Buffer.from(input.subarray(offset));
    if (count) this.scrubbed(count);
  }
}
