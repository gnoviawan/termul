/**
 * `bun tools/chat/tail-probe.ts [--port N] [--state DIR]`
 *
 * Prints the geometry of the matrix transcript's tail as the web client lays
 * it out, scrolled to the bottom: the scroller viewport and its content, the
 * chain from the last reply's action row up to the viewport, every block of
 * the last turn, and the Changed files bar with its ancestors up to the chat
 * panel. The native transcript tail is tuned against it.
 */

import { parseArgs } from 'node:util'
import { withProbeChat } from './probe-page'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-tail-probe' }
  }
})

await withProbeChat(
  {
    root: values.state as string,
    port: values.port ? Number(values.port) : undefined,
    deviceId: 'tail-probe'
  },
  async (page) => {
    await page.getByText('Changed files', { exact: false }).first().waitFor()
    await page.waitForTimeout(1500)
    const report = await page.evaluate(() => {
      const round = (n: number) => Math.round(n * 100) / 100
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return [r.left, r.top, r.width, r.height].map(round)
      }
      const box = (el: Element) => {
        const cs = getComputedStyle(el)
        return {
          tag: el.tagName.toLowerCase(),
          slot: el.getAttribute('data-slot') ?? undefined,
          testid: el.getAttribute('data-testid') ?? undefined,
          class: (el.getAttribute('class') ?? '').slice(0, 160),
          rect: rect(el),
          margin: cs.margin,
          padding: cs.padding,
          gap: cs.gap,
          border: cs.borderTopWidth,
          font: `${cs.fontSize}/${cs.lineHeight}`
        }
      }
      const up = (from: Element | null, stop: (el: Element) => boolean) => {
        const out: ReturnType<typeof box>[] = []
        for (let el = from; el && !stop(el); el = el.parentElement) out.push(box(el))
        return out
      }
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
      if (!viewport) return { error: 'no viewport' }
      const content = viewport.firstElementChild
      const copy = Array.from(viewport.querySelectorAll('button')).filter((b) =>
        /copy/i.test(b.getAttribute('aria-label') ?? b.getAttribute('title') ?? '')
      )
      const lastCopy = copy.at(-1) ?? null
      const changed = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'Changed files'
      )
      const turnBlocks = (() => {
        let el: Element | null = lastCopy
        while (el && el.parentElement && el.parentElement !== content) el = el.parentElement
        const out: ReturnType<typeof box>[] = []
        for (let sib = el; sib; sib = sib.previousElementSibling) {
          out.push(box(sib))
          if (out.length > 4) break
        }
        return out
      })()
      return {
        viewport: {
          ...box(viewport),
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight
        },
        content: content ? box(content) : null,
        contentChildren: content ? Array.from(content.children).slice(-3).map(box) : [],
        actionChain: up(lastCopy, (el) => el === viewport),
        turnBlocks,
        changedChain: up(changed ?? null, (el) => el.tagName === 'BODY').slice(0, 12),
        barParts: Array.from(changed?.closest('button')?.querySelectorAll('*') ?? []).map(box)
      }
    })
    console.log(JSON.stringify(report, null, 2))
  }
)
