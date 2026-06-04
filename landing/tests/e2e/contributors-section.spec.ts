import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { contributors } from '../../src/data/contributors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotDir = path.resolve(
  __dirname,
  '../../test-results/snapshots',
);

test.describe('Contributors section', () => {
  test.beforeAll(() => {
    mkdirSync(snapshotDir, { recursive: true });
  });

  test('renders heading, count badge, and contributor avatars', async ({
    page,
  }) => {
    await page.goto('/');

    const section = page.getByTestId('contributors-section');
    await section.scrollIntoViewIfNeeded();

    await expect(
      page.getByRole('heading', { name: /Contributors/i }),
    ).toBeVisible();
    await expect(
      page.getByLabel(`${contributors.length} contributors`),
    ).toHaveText(String(contributors.length));

    const list = page.getByRole('list', { name: 'Project contributors' });
    await expect(list.getByRole('listitem')).toHaveCount(contributors.length);

    for (const contributor of contributors) {
      await expect(
        page.getByRole('link', {
          name: `@${contributor.username} on GitHub`,
        }),
      ).toHaveAttribute('href', `https://github.com/${contributor.username}`);
    }
  });

  test('shows GitHub username tooltip on avatar hover', async ({ page }) => {
    await page.goto('/');

    const firstContributor = contributors[0];
    const avatarLink = page.getByRole('link', {
      name: `@${firstContributor.username} on GitHub`,
    });

    await avatarLink.scrollIntoViewIfNeeded();
    await avatarLink.hover();

    await expect(page.getByRole('tooltip')).toHaveText(
      `@${firstContributor.username}`,
    );
  });

  test('matches contributors section snapshot', async ({ page }) => {
    await page.goto('/');

    const section = page.getByTestId('contributors-section');
    await section.scrollIntoViewIfNeeded();

    await expect(section.locator('img').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);

    await expect(section).toHaveScreenshot('contributors-section.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });

    await section.screenshot({
      path: path.join(snapshotDir, 'contributors-section.png'),
    });
  });

  test('matches contributors section with tooltip snapshot', async ({ page }) => {
    await page.goto('/');

    const firstContributor = contributors[0];
    const section = page.getByTestId('contributors-section');
    const avatarLink = page.getByRole('link', {
      name: `@${firstContributor.username} on GitHub`,
    });

    await section.scrollIntoViewIfNeeded();
    await avatarLink.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.waitForTimeout(300);

    await expect(section).toHaveScreenshot('contributors-section-tooltip.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });

    await section.screenshot({
      path: path.join(snapshotDir, 'contributors-section-tooltip.png'),
    });
  });
});
