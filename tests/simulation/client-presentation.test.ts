import { describe, expect, it } from 'vitest';
import { fileCommands, readTextPreview, runPresentation } from '../../console/presentation.js';

describe('shared client presentation', () => {
  it('distinguishes allocation, readiness, input, and completion without infrastructure states', () => {
    expect(runPresentation({status: 'running', ready: false}).label).toBe('Starting');
    expect(runPresentation({status: 'running', ready: true}).label).toBe('Working');
    expect(runPresentation({status: 'running', ready: true, pendingRequests: [{}]}).label).toBe('Needs input');
    for (const status of ['cancelling', 'cancelled', 'failed', 'succeeded']) {
      expect(runPresentation({status, ready: false, pendingRequests: [{}]}).label).not.toBe('Needs input');
    }
    expect(runPresentation({status: 'succeeded', settling: true}).label).toBe('Saving');
    expect(runPresentation({status: 'succeeded', settling: false}).label).toBe('Done');
  });

  it('quotes opaque file IDs and destination paths, and omits text preview for binary files', () => {
    const commands = fileCommands('my-thread', {id: 'opaque-id', path: "reports/customer's report.json", mediaType: 'application/problem+json; charset=utf-8'});
    expect(commands).toContainEqual(['Preview in terminal', "rat-things file 'opaque-id' --thread 'my-thread' --preview"]);
    expect(commands.at(-1)?.[1]).toContain("--download './customer'\\''s report.json'");
    expect(fileCommands('my-thread', {id: 'image', path: 'image.png', mediaType: 'image/png'})).toHaveLength(2);
  });

  it('preserves UTF-8 across stream chunks and accepts an exact-size file without a truncation warning', async () => {
    const bytes = new TextEncoder().encode('A🌍B');
    const response = new Response(new ReadableStream({start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3));
      controller.close();
    }}));
    expect(await readTextPreview(response, bytes.length)).toEqual({text: 'A🌍B', truncated: false});
  });

  it('stops reading and cancels large files once the preview bound is exceeded', async () => {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('abcdef'));
    }, cancel() {cancelled = true;}}, {highWaterMark: 0}));
    expect(await readTextPreview(response, 4)).toEqual({text: 'abcd', truncated: true});
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);
  });
});
