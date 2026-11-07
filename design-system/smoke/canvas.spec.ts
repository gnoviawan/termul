import { expect, test } from 'playwright/test'
import { nameProblems, readAxNodes } from './helpers/ax-name'
import { openCanvas, readRegistry } from './helpers/canvas'

test('the canvas loads with no console errors', async ({ page }) => {
  const { errors } = await openCanvas(page)
  expect(errors).toEqual([])
})

test('every registry entry renders its preview', async ({ page }) => {
  await openCanvas(page)
  const entries = await readRegistry(page)
  expect(entries.length).toBeGreaterThan(0)

  for (const entry of entries) {
    const item = page.locator(`[data-canvas-item="${entry.id}"]`)
    await expect.soft(item, `${entry.id} is on the canvas`).toHaveCount(1)
    const frame = item.locator('[data-preview-frame]')
    // A preview that threw or rendered nothing leaves an empty frame.
    await expect
      .soft(frame.locator(':scope > *').first(), `${entry.id} renders content`)
      .toBeAttached()
    const box = await frame.boundingBox()
    expect.soft(box && box.width > 0 && box.height > 0, `${entry.id} has a size`).toBe(true)
  }

  // No orphan items: everything on the canvas comes from the registry.
  const onCanvas = await page
    .locator('[data-canvas-item]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-canvas-item')))
  expect(onCanvas.sort()).toEqual(entries.map((entry) => entry.id).sort())
})

test('button names in Chrome have no space before a comma or period', async ({ page }) => {
  await openCanvas(page)
  const entries = await readRegistry(page)
  const buttons = await readAxNodes(page, ['button'])
  expect(buttons.length).toBeGreaterThan(0)

  const covered = new Set(buttons.map((button) => button.entryId))
  // Every entry has at least its Move and Copy name buttons, so a gap here means the AX read missed it.
  for (const entry of entries) {
    expect.soft(covered.has(entry.id), `${entry.id} has buttons in the AX tree`).toBe(true)
  }

  const bad = buttons
    .map((button) => ({
      entry: button.entryId ?? '(canvas chrome)',
      name: JSON.stringify(button.name),
      problems: nameProblems(button.name)
    }))
    .filter((button) => button.problems.length > 0)
  expect(bad).toEqual([])
})
