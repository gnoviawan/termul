import { expect, test } from '@playwright/test';

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
  }

  await page.waitForLoadState('networkidle');

  await scrollHost.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect
    .poll(() => scrollHost.evaluate((el) => el.scrollTop))
    .toBeLessThan(5);
}

test.describe('Landing page', () => {
  test('matches full landing page snapshot', async ({ page }) => {
    await page.goto('/');

    await page.locator('main#main-content').waitFor({ state: 'visible' });
    await page
      .getByRole('heading', { name: /Contributors/i })
      .scrollIntoViewIfNeeded();

    const contributorAvatar = page
      .getByTestId('contributors-section')
      .locator('img')
      .first();
    await expect(contributorAvatar).toBeVisible({ timeout: 15_000 });
    await expect(contributorAvatar).toHaveJSProperty('complete', true);
    await expect(contributorAvatar).not.toHaveJSProperty('naturalWidth', 0);

    await scrollThroughLanding(page);

    const pageContent = page.locator('.min-h-screen');

    await expect(pageContent).toHaveScreenshot('landing-page-full.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });
  });
});
