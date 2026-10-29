import type { ConsoleMessage, Page } from 'playwright/test'

export interface RegistryEntry {
  id: string
  name: string
  section: string
}

/**
 * Loads the canvas with a clean saved layout and collects console errors and
 * uncaught page errors from the first byte.
 */
export async function openCanvas(page: Page): Promise<{ errors: string[] }> {
  const errors: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await page.addInitScript(() => window.localStorage.clear())
  await page.goto('/')
  await page.locator('[data-canvas-item]').first().waitFor()
  // Previews mount effects and fonts after first paint; let them settle.
  await page.waitForLoadState('networkidle')
  return { errors }
}

/**
 * Reads the canvas registry from the running app, so new entries are covered
 * without editing the smoke. The dev server serves source modules, and Vite
 * hands back the same module instance the app already imported.
 */
export async function readRegistry(page: Page): Promise<RegistryEntry[]> {
  return page.evaluate(async () => {
    const path = '/src/registry/index.tsx'
    const registry = (await import(/* @vite-ignore */ path)) as {
      SECTIONS: { id: string; groups: { entries: { id: string; name: string }[] }[] }[]
    }
    return registry.SECTIONS.flatMap((section) =>
      section.groups.flatMap((group) =>
        group.entries.map((entry) => ({ id: entry.id, name: entry.name, section: section.id }))
      )
    )
  })
}
