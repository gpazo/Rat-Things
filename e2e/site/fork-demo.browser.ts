import { expect, test } from '@playwright/test';

for (const [name, key] of [
  ['Paper & ink', 'paper'],
  ['After hours', 'midnight'],
]) {
  test(`forks, keeps ${name}, discards the other path, downloads and resets`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        request.url().startsWith('http') &&
        !request.url().startsWith('http://127.0.0.1:')
      )
        external.push(request.url());
    });
    await page.goto('/Rat-Things/fork-demo/');
    await expect(
      page.getByText('Interactive walkthrough · no cloud resources'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Prepare the starting point' })
      .click();
    await page.getByRole('button', { name: 'Fork into two themes' }).click();
    await expect(
      page
        .frameLocator('iframe[title="Paper & ink design"]')
        .getByRole('heading', { level: 1 }),
    ).toContainText('Good ideas');
    await expect(
      page
        .frameLocator('iframe[title="After hours design"]')
        .getByRole('heading', { level: 1 }),
    ).toContainText('spark');
    await page.screenshot({
      path: `test-results/site/fork-${key}-comparison.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('button', { name: `Keep ${name} and discard the other path` })
      .click();
    await expect(page.locator('.branch.kept')).toHaveAttribute(
      'data-branch',
      key!,
    );
    await expect(page.locator('.branch.discarded')).toContainText('let go');
    await expect(page.locator('.branch.discarded iframe')).toHaveCount(0);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download this design' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('fieldnotes.html');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toContain(name);
    await page.screenshot({
      path: `test-results/site/fork-${key}-chosen.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(
      page.getByRole('button', { name: 'Prepare the starting point' }),
    ).toBeVisible();
    await expect(page.locator('.branch')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}
test('fits mobile, supports keyboard controls and shows a useful missing-live-server error', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/fork-demo/');
  await page.screenshot({
    path: 'test-results/site/fork-mobile-start.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Prepare the starting point' })
    .focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Fork into two themes' }).click();
  await expect(page.locator('.branch')).toHaveCount(2);
  await expect(page.locator('.branch').last()).toHaveCSS('opacity', '1');
  await expect(
    page
      .frameLocator('iframe[title="After hours design"]')
      .getByRole('heading', { level: 1 }),
  ).toContainText('spark');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/site/fork-mobile-comparison.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('[data-branch="midnight"]').scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    path: 'test-results/site/fork-mobile-midnight.png',
    animations: 'disabled',
  });
  await page
    .getByRole('button', {
      name: 'Keep After hours and discard the other path',
    })
    .click();
  await expect(
    page.getByRole('link', { name: 'Download this design' }),
  ).toBeVisible();
  await page.goto('/fork-demo/?mode=live');
  await expect(page.getByRole('alert')).toContainText(
    'live demo server is unavailable',
  );
});

test('keeps generated preview links inside the comparison and strips executable content', async ({
  page,
}) => {
  const html =
    '<html><body><h1>Generated design</h1><a href="#features">Explore the design</a><script>document.body.textContent="unexpected script"</script><iframe src="about:blank"></iframe></body></html>';
  await page.route('**/fork-demo/api/state', (route) =>
    route.fulfill({
      json: {
        phase: 'comparing',
        busy: false,
        status: 'Preview fixture',
        error: null,
        source: { sessionId: 'fixture-source' },
        winner: null,
        branches: [
          { key: 'paper', sessionId: 'fixture-paper', html },
          { key: 'midnight', sessionId: 'fixture-midnight', html },
        ],
      },
    }),
  );
  await page.goto('/fork-demo/?mode=live');
  const preview = page.frameLocator('iframe[title="Paper & ink design"]');
  await expect(
    preview.getByRole('heading', { name: 'Generated design' }),
  ).toBeVisible();
  await expect(preview.locator('a')).not.toHaveAttribute('href');
  await expect(preview.locator('script, iframe')).toHaveCount(0);
  await preview.getByText('Explore the design').click();
  await expect(
    preview.getByRole('heading', { name: 'Generated design' }),
  ).toBeVisible();
});
