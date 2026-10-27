import type { Page } from 'playwright'
import type { Shot } from '../shot'
import { openApp } from '../ui'

// Browser tabs, page annotations and agent browser control are desktop-only,
// so this section only screenshots the canvas entry points.

async function openNewTabMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Open canvas' }).waitFor()
}

export const shots: Shot[] = [
  {
    id: 'browser-canvas-new-tab-menu',
    run: async (page) => {
      await openApp(page)
      await openNewTabMenu(page)
      return page.getByRole('menu')
    }
  },
  {
    id: 'browser-canvas-palette',
    run: async (page) => {
      await openApp(page)
      await page.getByRole('button', { name: 'Search', exact: true }).first().click()
      await page.keyboard.type('canvas')
      await page.getByText('Open Canvas', { exact: true }).waitFor()
    }
  }
]
