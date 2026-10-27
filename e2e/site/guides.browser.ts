import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const guidePages = JSON.parse(readFileSync('site/guides.json', 'utf8')).pages as Record<string, {
  reviewed: string;
  published: string;
}>;

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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path: `test-results/site/docs-index-${width}.png`});
    await page.getByRole('navigation', {name: 'Documentation header'}).getByRole('link', {name: 'Guides', exact: true}).click();
    await expect(page).toHaveURL(/\/guides\/$/);
    await expect(page.locator('h1')).toContainText('Practical guides');
    const cards = page.locator('.guide-card');
    await expect(cards).toHaveCount(Object.keys(guidePages).length);
    const paths = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).pathname));
    expect(new Set(paths).size).toBe(Object.keys(guidePages).length);
    await page.screenshot({path: `test-results/site/guides-index-${width}.png`});

    for (const [index, path] of paths.entries()) {
      await page.goto(path);
      await expect(page.locator('article h1')).toHaveCount(1);
      const metadata = guidePages[`${path.split('/').filter(Boolean).at(-1)}.md`];
      if (!metadata) throw new Error(`No guide metadata for ${path}`);
      const reviewed = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
      }).format(new Date(`${metadata.reviewed}T00:00:00Z`));
      await expect(page.locator('.guide-meta')).toContainText(`Reviewed ${reviewed}`);
      await expect(page.locator('.guide-related > a')).toHaveCount(2);
      const schema = JSON.parse(await page.locator('script[data-schema="article"]').textContent() ?? '{}');
      expect(schema.mainEntityOfPage).toBe(`https://gpazo.github.io/Rat-Things${path}`);
      expect(schema.dateModified).toBe(metadata.reviewed);
      expect(schema.datePublished).toBe(metadata.published);
      const faqScript = page.locator('script[data-schema="faq"]');
      if (await faqScript.count()) {
        const faq = JSON.parse(await faqScript.textContent() ?? '{}');
        expect(faq['@type']).toBe('FAQPage');
        expect(faq.mainEntity.length).toBeGreaterThan(0);
        for (const question of faq.mainEntity) {
          const heading = page.locator('article').getByRole('heading', {name: question.name});
          await expect(heading).toHaveCount(1);
          expect(await heading.evaluate(node => {
            const copy = node.cloneNode(true) as HTMLElement;
            copy.querySelector('.heading-anchor')?.remove();
            return copy.textContent?.trim();
          })).toBe(question.name);
          const visibleAnswer = await heading.evaluate(node => {
            const blocks: string[] = [];
            for (let sibling = node.nextElementSibling; sibling && !/^H[23]$/.test(sibling.tagName); sibling = sibling.nextElementSibling) {
              blocks.push(sibling.outerHTML);
            }
            return blocks.join('\n');
          });
          const schemaAnswer = await page.evaluate((html: string) =>
            new DOMParser().parseFromString(html, 'text/html').body.innerHTML,
          question.acceptedAnswer.text);
          expect(schemaAnswer.trim().replace(/\s+/g, ' ')).toBe(visibleAnswer.replace(/\s+/g, ' '));
        }
      }
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
  await page.goto('/docs/agents-api/');
  const harnessGuide = page.getByRole('link', {name: 'Can I run the OpenAI Agents API harness in my own AWS account?', exact: true});
  await expect(harnessGuide).toHaveAttribute('href', '../../guides/self-host-openai-agents-api-aws/');
  await harnessGuide.click();
  await expect(page).toHaveURL(/\/guides\/self-host-openai-agents-api-aws\/$/);
  await expect(page.locator('article h1')).toContainText('Can I run the OpenAI Agents API harness');
  for (const path of ['/', '/architecture/']) {
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

test('the homepage and architecture are readable without JavaScript', async ({request}) => {
  const home = await (await request.get('/')).text();
  expect(home).toContain('Small beginnings.<br>Room to grow.');
  expect(home).toContain('href="architecture/"');
  const architecture = await (await request.get('/architecture/')).text();
  expect(architecture).toContain('class="architecture-outline"');
  for (const system of ['Ingress', 'Execution', 'Delivery']) expect(architecture).toContain(`<h3>${system} <span>`);
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('/Rat-Things/architecture/</loc>');
});

test('the former overview address redirects to the homepage', async ({page}) => {
  await page.goto('/overview.html');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', {name: 'Small beginnings. Room to grow.'})).toBeVisible();
});

test('search metadata and answers are present in the initial HTML', async ({request}) => {
  const origin = 'https://gpazo.github.io/Rat-Things';
  for (const path of ['/', '/docs/']) {
    const html = await (await request.get(path)).text();
    expect(html).toContain('Self-hosted AI agent');
    expect(html).toContain(`<link rel="canonical" href="${origin}${path}">`);
    const softwareJson = html.match(/<script[^>]*data-schema="software">([\s\S]*?)<\/script>/)?.[1];
    expect(softwareJson).toBeTruthy();
    const software = JSON.parse(softwareJson ?? '{}');
    expect(software['@type']).toContain('SoftwareApplication');
    expect(software.codeRepository).toBe('https://github.com/gpazo/Rat-Things');
    expect(software).not.toHaveProperty('offers');
  }
  const sitemap = await (await request.get('/sitemap.xml')).text();
  const llms = await (await request.get('/llms.txt')).text();
  for (const slug of Object.keys(guidePages).map(file => file.replace(/\.md$/, ''))) {
    const path = `/guides/${slug}/`;
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain(`<link rel="canonical" href="${origin}${path}">`);
    expect(sitemap).toContain(`${origin}${path}</loc>`);
    expect(llms).toContain(`${origin}${path}`);
    if (slug !== 'aws-ai-agent-cost') {
      expect(html).toContain('id="frequently-asked-questions"');
      expect(html).toContain('"@type":"FAQPage"');
    }
  }
  const overview = await (await request.get('/overview.html')).text();
  expect(overview).toContain('<meta name="robots" content="noindex">');
  expect(overview).toContain(`<link rel="canonical" href="${origin}/">`);
  expect(sitemap).not.toContain('overview.html');
});
