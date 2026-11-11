import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../../../artifacts/session-design/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const results = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4177/?scene=session&try=1');
    const draft = page.getByRole('textbox', { name: 'Message', exact: true });
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await draft.fill('Keep the original context.');
    await page.getByRole('button', { name: 'Cancel reply' }).click();
    assert.equal(await draft.inputValue(), 'Keep the original context.');
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.equal(await page.locator('.sc-history .sc-quote').count(), 0);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await draft.fill('A reply with evidence.');
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.equal(await page.locator('.sc-history .sc-quote').count(), 1);
    assert.equal(await draft.inputValue(), '');
    await draft.fill('Preserve this draft.');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    assert.equal(await page.getByText('Read direction.md', { exact: true }).isVisible(), true);
    assert.equal(await draft.inputValue(), 'Preserve this draft.');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByRole('button', { name: width < 760 ? 'Work' : 'Shared workspace', exact: true }).click();
    assert.equal(await page.getByRole('link', { name: 'Open the workspace study' }).isVisible(), true);
    await page.getByRole('button', { name: width < 760 ? 'Work' : 'Shared workspace', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Viewer access' }).check();
    assert.equal(await draft.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Reply', exact: true }).count(), 0);
    await page.getByRole('checkbox', { name: 'Viewer access' }).uncheck();
    assert.equal(await draft.inputValue(), 'Preserve this draft.');
    await page.setViewportSize({ width: width < 760 ? 1280 : 390, height: 1000 });
    assert.equal(await draft.inputValue(), 'Preserve this draft.');
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await draft.inputValue(), 'Preserve this draft.');
    await page.screenshot({ path: output + `interactive-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ width, replyCancellationPreservesDraft: true, unquotedSend: true, quotedSend: true, activity: true, workspaceLink: true, viewerReadOnly: true, resizePreservesDraft: true, reducedMotion: true, pageErrors: errors });
    await page.close();
  }
  await writeFile(output + 'interaction-checks.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
