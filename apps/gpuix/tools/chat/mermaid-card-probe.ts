/**
 * `bun tools/chat/mermaid-card-probe.ts [--port N] [--state DIR]`
 *
 * Prints the geometry of the matrix transcript's mermaid card as the web
 * client lays it out with Streamdown's controls: the header actions, the
 * diagram frame and its pan and zoom buttons, the diagram after one Zoom in,
 * the Download menu, and the fullscreen view. `src/chat/MermaidCard.tsx` is
 * tuned against it.
 */

import { parseArgs } from 'node:util'
import type { Page } from 'playwright'
import { withProbeChat } from './probe-page'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-mermaid-card-probe' }
  }
})

function measure(page: Page, rootSelector: string) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) as HTMLElement | null
    if (!root) return null
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100)
    }
    const box = (el: Element) => {
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        class: (el.getAttribute('class') ?? '').slice(0, 200),
        rect: rect(el),
        padding: cs.padding,
        border: `${cs.borderTopWidth} ${cs.borderTopColor}`,
        background: cs.backgroundColor,
        color: cs.color,
        radius: cs.borderRadius
      }
    }
    const svg = root.querySelector('svg[id^="mermaid"], [role="application"] svg')
    return {
      root: box(root),
      buttons: Array.from(root.querySelectorAll('button')).map((b) => ({
        ...box(b),
        label: b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent,
        disabled: (b as HTMLButtonElement).disabled,
        svg: b.querySelector('svg') ? rect(b.querySelector('svg') as Element) : null
      })),
      groups: Array.from(root.querySelectorAll('button'))
        .map((b) => b.parentElement)
        .filter((el, i, all): el is HTMLElement => !!el && all.indexOf(el) === i)
        .map(box),
      stage: root.querySelector('[role="application"]')
        ? box(root.querySelector('[role="application"]')?.parentElement as Element)
        : null,
      transform: (root.querySelector('[role="application"]') as HTMLElement | null)?.style
        .transform,
      diagram: svg ? rect(svg) : null
    }
  }, rootSelector)
}

await withProbeChat(
  {
    root: values.state as string,
    port: values.port ? Number(values.port) : undefined,
    deviceId: 'mermaid-card-probe'
  },
  async (page) => {
    const block = '[data-streamdown="mermaid-block"]'
    // Streamdown draws the diagram once its block scrolls into view.
    await page.locator(block).first().scrollIntoViewIfNeeded()
    await page.locator(`${block} [role="application"] svg`).first().waitFor()
    const card = await measure(page, block)
    await page.locator(block).getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForTimeout(300)
    const zoomed = await measure(page, block)
    await page.locator(block).getByRole('button', { name: 'Reset zoom and pan' }).click()
    await page.locator(block).getByRole('button', { name: 'Download diagram' }).click()
    const menu = await page.evaluate((selector) => {
      const root = document.querySelector(selector) as HTMLElement
      const items = Array.from(root.querySelectorAll('button[title^="Download diagram as"]'))
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100)
      }
      const list = items[0]?.parentElement
      return {
        list: list
          ? {
              class: list.getAttribute('class'),
              rect: rect(list),
              background: getComputedStyle(list).backgroundColor
            }
          : null,
        items: items.map((b) => ({
          text: b.textContent,
          class: b.getAttribute('class'),
          rect: rect(b),
          font: `${getComputedStyle(b).fontSize}/${getComputedStyle(b).lineHeight}`
        }))
      }
    }, block)
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
    await page.locator(block).getByRole('button', { name: 'View fullscreen' }).click()
    const full = '[data-streamdown="mermaid-fullscreen"]'
    await page.locator(`${full} [role="application"] svg`).waitFor()
    await page.waitForTimeout(500)
    const fullscreen = await measure(page, full)
    console.log(JSON.stringify({ card, zoomed, menu, fullscreen }, null, 1))
  }
)
