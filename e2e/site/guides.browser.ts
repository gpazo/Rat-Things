import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`guides support navigation and reading at ${width}px`, async ({page}) => {
    test.setTimeout(60_000);
    await page.setViewportSize({width, height: 900});
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).origin === new URL(page.url()).origin) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto('/docs/');
    await page.getByRole('navigation', {name: 'Documentation header'}).getByRole('link', {name: 'Guides', exact: true}).click();
    await expect(page).toHaveURL(/\/guides\/$/);
    await expect(page.locator('h1')).toContainText('Practical guides');
    const cards = page.locator('.guide-card');
    await expect(cards).toHaveCount(8);
    const paths = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).pathname));
    expect(new Set(paths).size).toBe(8);
    await page.screenshot({path: `test-results/site/guides-index-${width}.png`});

    for (const [index, path] of paths.entries()) {
      await page.goto(path);
      await expect(page.locator('article h1')).toHaveCount(1);
      await expect(page.locator('.guide-meta')).toContainText('Reviewed September 7, 2026');
      await expect(page.locator('.guide-related > a')).toHaveCount(2);
      const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() ?? '{}');
      expect(schema.mainEntityOfPage).toBe(`https://gpazo.github.io/Rat-Things${path}`);
      expect(schema.dateModified).toBe('2026-09-07');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width < 1180) {
        await page.locator('.guide-mobile-toc summary').click();
        await page.locator('.guide-mobile-toc a').first().click();
      } else {
        await page.locator('.guide-toc a').first().click();
      }
      expect(new URL(page.url()).hash).not.toBe('');
      await page.locator('.guide-cta-primary').click();
      await expect(page.locator('h1')).toBeVisible();
      if (index === 0) {
        await page.goto(path);
        await page.screenshot({path: `test-results/site/guide-article-${width}.png`});
      }
    }
    expect(failures).toEqual([]);
  });
}

test('website entry points and discovery files include the guides', async ({page, request}) => {
  for (const path of ['/', '/overview.html']) {
    await page.goto(path);
    await expect(page.locator('header').getByRole('link', {name: 'Guides', exact: true})).toBeVisible();
  }
  for (const path of ['/sitemap.xml', '/llms.txt']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const body = await response.text();
    expect(body).toContain('/guides/durable-ai-agent-state/');
    expect(body).not.toContain('codex-pilot-count');
  }
});
