import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`local onboarding leads from the homepage to setup and AWS at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Small beginnings.Room to grow.');
    await page.screenshot({ path: `test-results/site/local-overview-${width}.png` });
    await page.getByRole('link', { name: 'Start on this computer', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/local-workspace\/$/);
    await expect(page.locator('article h1')).toContainText('A little help, right at home');
    await expect(page.locator('article')).toContainText('npm run console:serve');
    await expect(page.locator('article')).toContainText('not offline model inference');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/site/local-guide-${width}.png` });
    await page.locator('article').getByRole('link', { name: 'AWS quickstart', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/quickstart\/$/);
  });
}
