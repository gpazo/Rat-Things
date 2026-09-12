import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  filePublicationPlan,
  sitePublicationPlan,
  videoPublicationPlan,
} from '../../src/core/publication-builders.js';
import { defaultPublicationBuilders } from '../../src/core/publication-service.js';
import type { PublicationSourceFile } from '../../src/core/publication-planning.js';
import type { PublicationSpec } from '../../src/domain/publications.js';
import { sourceFile } from './publication-fixtures.js';

const planners = { file: filePublicationPlan, site: sitePublicationPlan, video: videoPublicationPlan };

// These digests capture the viewer formats used by already committed publications.
const viewers: { label: string; spec: PublicationSpec; files: PublicationSourceFile[]; digest: string }[] = [
  {
    label: 'image with escaped title and asset path',
    spec: { version: '1', kind: 'file', path: 'nested/a & b.png', title: '<Demo & "preview">' },
    files: [sourceFile('nested/a & b.png', 'image/png')],
    digest: 'f1ddab051b77f0d71e312f96386289f548ae09bcbd2a3eee2778172bcdeb845a',
  },
  {
    label: 'audio with an explicitly empty title',
    spec: { version: '1', kind: 'file', path: 'sound.mp3', title: '' },
    files: [sourceFile('sound.mp3', 'audio/mpeg')],
    digest: 'a8e589fa746e10bc55ef82807d9bfc090e7d8fe87cf338304f73765f080b3b0e',
  },
  {
    label: 'PDF with a default title',
    spec: { version: '1', kind: 'file', path: 'report.pdf' },
    files: [sourceFile('report.pdf', 'application/pdf')],
    digest: '832be4520a79ec779bab238f8f776e158ac1f46931df87eb6ad67ca2852e2bf2',
  },
  {
    label: 'generic file download',
    spec: { version: '1', kind: 'file', path: 'notes.txt' },
    files: [sourceFile('notes.txt', 'text/plain')],
    digest: 'c8b84706eea902cae09cda205e74fa421c6acfaf1cde9ef31b901a3704a0e269',
  },
  {
    label: 'video with a poster',
    spec: { version: '1', kind: 'video', path: 'movie.mp4', poster: 'img/poster.webp' },
    files: [sourceFile('movie.mp4', 'video/mp4'), sourceFile('img/poster.webp', 'image/webp')],
    digest: '8930ee0f19f33ffa7dd4dd455531224010a8c3a1857cebdd145d815579496538',
  },
  {
    label: 'site redirect',
    spec: { version: '1', kind: 'site', root: 'dist', entrypoint: 'pages/start here.html', title: '<Go>' },
    files: [sourceFile('dist/pages/start here.html', 'text/html')],
    digest: 'f009998f140021ddb30ccc38ba1a8a349c35e4920447d2147ae67f1c9af86203',
  },
];

describe('publication builders', () => {
  it.each(viewers)('preserves the exact $label viewer bytes and async port result', async ({ spec, files, digest }) => {
    const before = structuredClone(files);
    Object.freeze(files);
    for (const file of files) { Object.freeze(file); Object.freeze(file.blob); }
    const result = planners[spec.kind](Object.freeze(spec), files);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a valid plan');
    const generated = result.value.files.find((file) => file.source === 'generated');
    if (generated?.source !== 'generated') throw new Error('expected a generated viewer');
    expect(createHash('sha256').update(generated.bytes).digest('hex')).toBe(digest);
    expect(await defaultPublicationBuilders().get(spec.kind).plan(spec, files)).toEqual(result);
    expect(files).toEqual(before);
  });

  it('keeps source order and blob identity while selecting a site root', () => {
    const files = Object.freeze([
      sourceFile('dist/z.js', 'text/javascript'),
      sourceFile('outside.txt', 'text/plain'),
      sourceFile('dist/index.html', 'text/html'),
    ]);
    expect(sitePublicationPlan({ version: '1', kind: 'site', root: 'dist' }, files)).toEqual({
      ok: true,
      value: {
        kind: 'site', entrypoint: 'index.html',
        files: [
          { source: 'blob', path: 'z.js', blob: files[0]!.blob },
          { source: 'blob', path: 'index.html', blob: files[2]!.blob },
        ],
      },
    });
  });

  it('reports a kind mismatch before inspecting missing files', () => {
    expect(filePublicationPlan({ version: '1', kind: 'site' }, [])).toEqual({
      ok: false, error: [{ code: 'invalid_request', message: 'file builder cannot publish site' }],
    });
  });

  it('reports an empty site root without replacing its falsey diagnostic value', () => {
    expect(sitePublicationPlan({ version: '1', kind: 'site', root: '' }, [])).toEqual({
      ok: false, error: [{ code: 'not_found', message: 'publication source  was not found' }],
    });
  });

  it('requires the declared entrypoint and does not overwrite an existing index', () => {
    const files = [sourceFile('dist/index.html', 'text/html')];
    const spec = { version: '1', kind: 'site', root: 'dist', entrypoint: 'start.html' } as const;
    expect(sitePublicationPlan(spec, files)).toMatchObject({
      ok: false, error: [{ code: 'not_found', path: 'dist/start.html' }],
    });
    expect(sitePublicationPlan(spec, [...files, sourceFile('dist/start.html', 'text/html')])).toMatchObject({
      ok: false, error: [{ code: 'path_collision', path: 'dist/start.html' }],
    });
  });

  it('checks the video before the poster and reports flattened asset collisions', () => {
    const spec = { version: '1', kind: 'video', path: 'video/demo.bin', poster: 'poster/demo.bin' } as const;
    const video = sourceFile(spec.path, 'text/plain');
    expect(videoPublicationPlan(spec, [video])).toMatchObject({
      ok: false, error: [{ code: 'unsupported_media', path: spec.path }],
    });
    video.blob.mediaType = 'video/mp4';
    expect(videoPublicationPlan(spec, [video])).toMatchObject({
      ok: false, error: [{ code: 'not_found', path: spec.poster }],
    });
    expect(videoPublicationPlan(spec, [video, sourceFile(spec.poster, 'image/png')])).toMatchObject({
      ok: false, error: [{ code: 'path_collision', path: spec.path }],
    });
  });
});
