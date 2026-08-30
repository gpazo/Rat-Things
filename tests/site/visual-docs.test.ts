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
    expect(homepage).toContain('../docs/product-overview.svg');
    expect(homepage).toContain('Thing lifecycle');
    expect(homepage).toContain('Permission intersection');
    expect(homepage).toContain('Durable execution');
    expect(homepage).not.toContain('c4-system-context.png');
    expect(homepage).not.toContain('c4-runtime-containers.png');
  });

  it('publishes accessible product screenshots and capability-focused copy', async () => {
    const homepage = await readFile('site/index.html', 'utf8');
    const buildScript = await readFile('scripts/build-pages.mjs', 'utf8');
    const screenshots = [
      { file: 'conversation-console-live-browser.png', format: 'png' },
      { file: 'conversation-console-live-activity.png', format: 'png' },
      { file: 'conversation-console-mobile-browser.png', format: 'png' },
      { file: 'connections-console.png', format: 'png' },
      { file: 'routines-console.png', format: 'png' },
      { file: 'cli-live-aws-attachment-reply.jpg', format: 'jpeg' },
    ];

    expect(homepage).toContain('id="console"');
    expect(homepage).toContain('Install connections');
    expect(homepage).toContain('Use connected services');
    expect(homepage).toContain('Connected services, one durable agent');
    expect(homepage).toContain('Install verified accounts');
    expect(homepage).toContain('Find and synthesize context');
    expect(homepage).toContain('The interface is the front door, not the limit.');
    expect(homepage).toContain('As many trusted integrations as you choose.');
    expect(homepage).toContain('One built-in example · Slack');
    expect(homepage).not.toContain('Available today in Slack');
    expect(homepage).toContain('Extensions are trusted host code.');
    expect(homepage).not.toContain('Slack live proof');
    expect(homepage).toContain('Operate routines');
    expect(homepage).toContain('The reference console and CLI are two views over the same public');
    expect(homepage).toContain('Durability by design');
    expect(homepage).not.toContain('slack-proof');
    expect(homepage).not.toContain('Client-side proof');
    expect(homepage).not.toContain('Operator-side proof');
    expect(homepage).not.toContain('236-resource');
    expect(homepage).not.toContain('662.74');
    expect(homepage).not.toContain('ux260826a');
    expect(homepage).not.toContain('cli260826a');
    expect(buildScript).not.toContain('slack-live-thread.jpg');
    expect(buildScript).not.toContain('slack-live-connections.jpg');
    for (const screenshot of screenshots) {
      const bytes = await readFile(`assets/${screenshot.file}`);
      if (screenshot.format === 'png') {
        expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      } else {
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      }
      expect(bytes.byteLength).toBeGreaterThan(20_000);
      expect(homepage).toMatch(new RegExp(
        `src="../assets/${escapeRegExp(screenshot.file)}"[^>]+alt="[^"]+"`,
      ));
      expect(buildScript).toContain(`'${screenshot.file}'`);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
