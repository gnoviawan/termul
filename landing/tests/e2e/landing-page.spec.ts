import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotDir = path.resolve(__dirname, '../../test-results/snapshots');

async function scrollThroughLanding(page: import('@playwright/test').Page) {
  const scrollHost = page
    .locator('[data-overlayscrollbars-viewport], .overflow-y-auto')
    .first();

  await scrollHost.waitFor({ state: 'visible', timeout: 15_000 });

  const scrollHeight = await scrollHost.evaluate((el) => el.scrollHeight);
  const viewportHeight = await scrollHost.evaluate((el) => el.clientHeight);
  const steps = Math.max(1, Math.ceil(scrollHeight / viewportHeight));

  for (let step = 0; step <= steps; step += 1) {
    const top = Math.min(step * viewportHeight, scrollHeight);
    await scrollHost.evaluate((el, scrollTop) => {
      el.scrollTop = scrollTop as number;
    }, top);
    await page.waitForTimeout(150);
  }

  await scrollHost.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(300);
}

test.describe('Landing page', () => {
  test.beforeAll(() => {
    mkdirSync(snapshotDir, { recursive: true });
  });

  test('matches full landing page snapshot', async ({ page }) => {
    await page.goto('/');

    await page.locator('main#main-content').waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: /Contributors/i }).scrollIntoViewIfNeeded();
    await page.getByTestId('contributors-section').locator('img').first().waitFor({
      state: 'visible',
      timeout: 15_000,
    });

    await scrollThroughLanding(page);

    const pageContent = page.locator('.min-h-screen');

    await expect(pageContent).toHaveScreenshot('landing-page-full.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });

    await pageContent.screenshot({
      path: path.join(snapshotDir, 'landing-page-full.png'),
    });
  });
});
