/**
 * `bun tools/parity/web-zoom-check.ts [--port N] [--state DIR]`
 *
 * The web client's own UI zoom (Alt+=, CSS `zoom` on the root outside Tauri)
 * in Chromium at the GPUIX window size, on this worktree's `dist-web`
 * (`bun run build:web` at the repo root). At 110 % the page must still end
 * at the window bottom, a context menu must open where it opens unzoomed
 * (2 px right of the pointer), and a dropdown must open under its trigger,
 * 4 px down at 110 %. Prints the measurements; exits non-zero on a failure.
 */

import { parseArgs } from 'node:util'
import { withProbeChat } from '../chat/probe-page'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-web-zoom-check' }
  }
})

let failed = 0
function assert(check: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}: ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance

await withProbeChat(
  {
    root: values.state as string,
    port: values.port ? Number(values.port) : undefined,
    deviceId: 'web-zoom-check'
  },
  async (page) => {
    await page.keyboard.press('Alt+Equal')
    await page.waitForFunction(() => document.documentElement.style.zoom !== '')
    await page.waitForTimeout(500)
    const zoom = Number(await page.evaluate(() => document.documentElement.style.zoom))
    assert('zoomed', near(zoom, 1.1, 0.001), `root zoom ${zoom}`)

    const page_ = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight
    }))
    assert(
      'the page ends at the window bottom',
      page_.scrollHeight === page_.innerHeight,
      `page ${page_.scrollHeight} px tall in a ${page_.innerHeight} px window`
    )

    const project = await page.getByText('beta', { exact: true }).first().boundingBox()
    if (!project) throw new Error('no beta project row')
    const pointer = { x: Math.round(project.x + 10), y: Math.round(project.y + project.height / 2) }
    await page.mouse.click(pointer.x, pointer.y, { button: 'right' })
    const menu = await page.locator('[role="menu"]').first().boundingBox()
    await page.keyboard.press('Escape')
    assert(
      'the context menu opens at the pointer',
      !!menu && near(menu.x, pointer.x + 2) && near(menu.y, pointer.y),
      `pointer ${pointer.x},${pointer.y}, menu ${menu ? `${Math.round(menu.x)},${Math.round(menu.y)}` : 'missing'}`
    )

    const trigger = page.getByRole('button', { name: 'Workspace' }).first()
    const anchor = await trigger.boundingBox()
    await trigger.click()
    const popover = await page.locator('[data-radix-popper-content-wrapper]').first().boundingBox()
    const below = anchor ? anchor.y + anchor.height + 4 * zoom : 0
    assert(
      'the dropdown opens under its trigger',
      !!anchor && !!popover && near(popover.x, anchor.x) && near(popover.y, below),
      `trigger ${anchor ? `${Math.round(anchor.x)},${Math.round(anchor.y + anchor.height)}` : 'missing'}, dropdown ${popover ? `${Math.round(popover.x)},${Math.round(popover.y)}` : 'missing'}`
    )
  }
)
process.exit(failed === 0 ? 0 : 1)
