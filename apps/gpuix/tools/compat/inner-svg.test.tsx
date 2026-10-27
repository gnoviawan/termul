import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer } from '@gpuix/react'
import type { ReactElement } from 'react'
import { jsx } from '../../src/compat/jsx-runtime'

/** Every operation the renderer is sent, as JSON. */
function rendered(element: ReactElement): string {
  const ops: unknown[] = []
  const tree = {
    applyBatch(json: string): number[] {
      ops.push(...(JSON.parse(json) as unknown[]))
      return []
    }
  }
  const root = createRoot(tree as unknown as NativeRenderer)
  flushSync(() => root.render(element))
  root.unmount()
  return JSON.stringify(ops)
}

describe('an <svg> set through dangerouslySetInnerHTML', () => {
  test("AcpAgentsSettings' icon tile paints the icon at its [&_svg] size, tinted by the inherited colour", () => {
    const html = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"/></svg>'
    const tile = jsx('span', {
      className: 'inline-flex h-5 w-5 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full',
      dangerouslySetInnerHTML: { __html: html }
    })
    const ops = rendered(tile)
    expect(ops).toContain(
      '<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\"><path fill=\\"#000\\"'
    )
    expect(ops).toContain('"width":"100%"')
  })

  test("an <svg> whose inner markup is set that way (ToolCallCard's robot) paints that markup", () => {
    const robot = jsx('svg', {
      viewBox: '0 0 24 24',
      dangerouslySetInnerHTML: { __html: '<rect width="4" height="4" stroke="currentColor"/>' }
    })
    expect(rendered(robot)).toContain(
      'viewBox=\\"0 0 24 24\\"><rect width=\\"4\\" height=\\"4\\" stroke=\\"#000\\"/></svg>'
    )
  })

  test('markup that paints its own colours becomes a full-colour image', () => {
    const ops = rendered(
      jsx('span', {
        dangerouslySetInnerHTML: {
          __html: '<svg viewBox="0 0 2 2"><path fill="#f00" d="M0 0h2v2H0z"/></svg>'
        }
      })
    )
    expect(ops).toContain('data:image/svg+xml;utf8,%3Csvg%20xmlns')
  })

  test("an <svg>'s inner markup is re-checked: a depth bomb paints an empty svg, an <image> is dropped", () => {
    const bomb = jsx('svg', {
      viewBox: '0 0 24 24',
      dangerouslySetInnerHTML: {
        __html: `${'<g>'.repeat(3500)}<path d="M0 0h1v1z"/>${'</g>'.repeat(3500)}`
      }
    })
    expect(rendered(bomb)).toContain(
      '"source","<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\"></svg>"'
    )
    const image = jsx('svg', {
      viewBox: '0 0 24 24',
      dangerouslySetInnerHTML: { __html: '<image href="/dev/zero"/><rect width="4" height="4"/>' }
    })
    expect(rendered(image)).toContain(
      'viewBox=\\"0 0 24 24\\"><rect width=\\"4\\" height=\\"4\\"/></svg>'
    )
  })

  test('other markup renders nothing', () => {
    const ops = rendered(jsx('div', { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }))
    expect(ops).not.toContain('source')
  })
})
