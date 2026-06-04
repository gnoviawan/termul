import { expect, test } from '@playwright/test';

import { getDisplayContributors } from '../../src/lib/contributors';

const displayedContributors = getDisplayContributors();

test.describe('Contributors section', () => {
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
      page.getByLabel(`${displayedContributors.length} contributors`),
    ).toHaveText(String(displayedContributors.length));

    const list = page.getByRole('list', { name: 'Project contributors' });
    await expect(list.getByRole('listitem')).toHaveCount(
      displayedContributors.length,
    );

    for (const contributor of displayedContributors) {
      await expect(
        page.getByRole('link', {
          name: `@${contributor.username} on GitHub`,
        }),
      ).toHaveAttribute('href', `https://github.com/${contributor.username}`);
    }
  });

  test('shows GitHub username tooltip on avatar hover', async ({ page }) => {
    await page.goto('/');

    const firstContributor = displayedContributors[0];
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

    const firstAvatar = section.locator('img').first();
    await expect(firstAvatar).toBeVisible({ timeout: 15_000 });
    await expect(firstAvatar).toHaveJSProperty('complete', true);
    await expect(firstAvatar).not.toHaveJSProperty('naturalWidth', 0);

    await expect(section).toHaveScreenshot('contributors-section.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });
  });

  test('matches contributors section with tooltip snapshot', async ({
    page,
  }) => {
    await page.goto('/');

    const firstContributor = displayedContributors[0];
    const section = page.getByTestId('contributors-section');
    const avatarLink = page.getByRole('link', {
      name: `@${firstContributor.username} on GitHub`,
    });

    await section.scrollIntoViewIfNeeded();
    await avatarLink.hover();

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(`@${firstContributor.username}`);

    await expect(section).toHaveScreenshot('contributors-section-tooltip.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });
  });
});
