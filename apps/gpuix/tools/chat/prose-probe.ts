/**
 * `bun tools/chat/prose-probe.ts [--port N] [--state DIR]`
 *
 * Prints the geometry of two matrix transcript blocks as the web client lays
 * them out: the bash code card (every element from the card down to the code
 * lines) and the ordered list (each item's box and where its text starts).
 * The native code card and markdown list are tuned against it.
 */

import { parseArgs } from 'node:util'
import { withProbeChat } from './probe-page'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-prose-probe' }
  }
})

await withProbeChat(
  {
    root: values.state as string,
    port: values.port ? Number(values.port) : undefined,
    deviceId: 'prose-probe'
  },
  async (page) => {
    await page.getByText('bun vitest run', { exact: false }).first().waitFor()
    const report = await page.evaluate(() => {
      const round = (n: number) => Math.round(n * 100) / 100
      const rect = (el: Element | Range) => {
        const r = el.getBoundingClientRect()
        return [r.left, r.top, r.width, r.height].map(round)
      }
      const box = (el: Element, depth: number) => {
        const cs = getComputedStyle(el)
        return {
          depth,
          tag: el.tagName.toLowerCase(),
          slot: el.getAttribute('data-streamdown') ?? undefined,
          class: (el.getAttribute('class') ?? '').slice(0, 140),
          rect: rect(el),
          padding: cs.padding,
          border: cs.borderTopWidth,
          font: `${cs.fontSize}/${cs.lineHeight}`,
          overflowX: cs.overflowX
        }
      }
      const walk = (el: Element, depth: number, out: ReturnType<typeof box>[]) => {
        if (depth > 8 || el.tagName.toLowerCase() === 'svg') return out
        out.push(box(el, depth))
        for (const child of Array.from(el.children)) walk(child, depth + 1, out)
        return out
      }
      const pre = Array.from(document.querySelectorAll('.chat-streamdown pre')).find((p) =>
        (p.textContent ?? '').includes('bun vitest run')
      )
      const card = pre?.closest('[data-streamdown="code-block"]') ?? pre?.parentElement
      const textStart = (el: Element) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const node = walker.nextNode()
        if (!node) return null
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, 1)
        return rect(range)
      }
      const ol = Array.from(document.querySelectorAll('.chat-streamdown ol')).find((o) =>
        (o.textContent ?? '').includes('WorkspaceLayout')
      )
      return {
        codeCard: card ? walk(card, 0, []) : null,
        orderedList: ol
          ? {
              list: box(ol, 0),
              items: Array.from(ol.children).map((li) => ({
                ...box(li, 1),
                listStyle: getComputedStyle(li).listStylePosition,
                marker: getComputedStyle(li, '::marker').content,
                text: (li.textContent ?? '').slice(0, 24),
                textStart: textStart(li)
              }))
            }
          : null
      }
    })
    console.log(JSON.stringify(report, null, 1))
  }
)
