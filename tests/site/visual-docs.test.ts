import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const visuals = [
  {
    file: 'product-overview.svg',
    primaryNodes: 3,
    document: 'docs/operating-model.md',
  },
  {
    file: 'thing-lifecycle.svg',
    primaryNodes: 5,
    document: 'docs/things.md',
  },
  {
    file: 'permission-intersection.svg',
    primaryNodes: 5,
    document: 'docs/plugins.md',
  },
  {
    file: 'durable-execution.svg',
    primaryNodes: 5,
    document: 'docs/architecture.md',
  },
] as const;

describe('visual documentation', () => {
  it.each(visuals)('$file is an accessible, focused, text-native SVG', async ({
    file,
    primaryNodes,
  }) => {
    const source = await readFile(`docs/${file}`, 'utf8');
    const titleId = source.match(/<title id="([^"]+)"/)?.[1];
    const descriptionId = source.match(/<desc id="([^"]+)"/)?.[1];
    const labelledBy = source.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(/\s+/);

    expect(source).toContain('<svg');
    expect(source).toContain('viewBox=');
    expect(source).toContain('role="img"');
    expect(source).toMatch(/data-visual-question="[^"]+\?"/);
    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(labelledBy).toEqual([titleId, descriptionId]);
    expect([...source.matchAll(/data-node="primary"/g)]).toHaveLength(primaryNodes);
    expect(source).not.toMatch(/<(?:script|foreignObject|image)\b/i);
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(40_000);
  });

  it.each(visuals)('$document embeds $file with an HTML figure and text alternative', async ({
    file,
    document,
  }) => {
    const source = await readFile(document, 'utf8');
    expect(source).toContain('<figure class="doc-visual');
    expect(source).toContain(`href="${file}"`);
    expect(source).toContain(`src="${file}"`);
    expect(source).toMatch(new RegExp(`src="${escapeRegExp(file)}" alt="[^"]+"`));
    expect(source).toContain('<figcaption><strong>');
  });

  it('uses the focused product SVG instead of the old raster C4 overview on the homepage', async () => {
    const homepage = await readFile('site/index.html', 'utf8');
    expect(homepage).toContain('assets/visuals/product-overview.svg');
    expect(homepage).toContain('Thing lifecycle');
    expect(homepage).toContain('Permission intersection');
    expect(homepage).toContain('Durable execution');
    expect(homepage).not.toContain('c4-system-context.png');
    expect(homepage).not.toContain('c4-runtime-containers.png');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
