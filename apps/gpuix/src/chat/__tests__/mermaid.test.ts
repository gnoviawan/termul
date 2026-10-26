import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetBrowserHostForTesting,
  type BrowserHost,
  registerBrowserHost
} from '@/lib/browser-host'
import type { MermaidRender } from '../../browser/mermaid-render'
import { _resetMermaidCacheForTesting, canDrawMermaid, drawMermaid, exportMermaid } from '../mermaid'

function hostAnswering(answer: (source: string, scale?: number) => MermaidRender): string[] {
  const asked: string[] = []
  const host = {
    renderMermaid: async (source: string, options?: { scale?: number }) => {
      asked.push(options?.scale ? `${source} @${options.scale}x` : source)
      return answer(source, options?.scale)
    }
  }
  registerBrowserHost(host as unknown as BrowserHost)
  return asked
}

afterEach(() => {
  _resetBrowserHostForTesting()
  _resetMermaidCacheForTesting()
})

describe('drawMermaid', () => {
  test('draws a source once and answers later cards from the cache', async () => {
    const asked = hostAnswering(() => ({
      ok: true,
      png: 'data:image/png;base64,AA',
      svg: '<svg/>',
      width: 9,
      height: 3
    }))
    const first = await drawMermaid('flowchart LR\n  A --> B')
    const again = await drawMermaid('flowchart LR\n  A --> B')
    expect(first).toEqual({
      ok: true,
      png: 'data:image/png;base64,AA',
      svg: '<svg/>',
      width: 9,
      height: 3
    })
    expect(again).toEqual(first)
    expect(asked).toEqual(['flowchart LR\n  A --> B'])
  })

  test('does not keep a failed render, so the next card asks again', async () => {
    const asked = hostAnswering(() => ({ ok: false, error: 'Parse error on line 1' }))
    expect(await drawMermaid('flowchart ??')).toEqual({ ok: false, error: 'Parse error on line 1' })
    await drawMermaid('flowchart ??')
    expect(asked).toEqual(['flowchart ??', 'flowchart ??'])
  })

  test('without a helper there is nothing to draw with', async () => {
    expect(canDrawMermaid()).toBe(false)
    expect(await drawMermaid('flowchart LR')).toEqual({
      ok: false,
      error: 'no webview helper in this client'
    })
  })
})

describe('exportMermaid', () => {
  const FLOW = 'flowchart LR\n  A --> B'

  test('saves the SVG mermaid drew for the card, without drawing again', async () => {
    const asked = hostAnswering(() => ({
      ok: true,
      png: 'data:image/png;base64,AA',
      svg: '<svg id="flow"/>',
      width: 9,
      height: 3
    }))
    await drawMermaid(FLOW)
    expect(await exportMermaid(FLOW, 'svg')).toEqual({ ok: true, data: '<svg id="flow"/>' })
    expect(asked).toEqual([FLOW])
  })

  test('draws the PNG at five times the diagram size, as Streamdown exports it', async () => {
    const asked = hostAnswering((_source, scale) => ({
      ok: true,
      png: scale === 5 ? 'data:image/png;base64,iVBORw==' : 'data:image/png;base64,AA',
      svg: '<svg/>',
      width: 9,
      height: 3
    }))
    const png = await exportMermaid(FLOW, 'png')
    expect(png.ok && Array.from(png.data as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(asked).toEqual([`${FLOW} @5x`])
  })

  test('saves the source as MMD with no helper at all', async () => {
    expect(await exportMermaid(FLOW, 'mmd')).toEqual({ ok: true, data: FLOW })
  })

  test('reports a render the helper cannot draw', async () => {
    hostAnswering(() => ({ ok: false, error: 'Parse error on line 1' }))
    expect(await exportMermaid('flowchart ??', 'png')).toEqual({
      ok: false,
      error: 'Parse error on line 1'
    })
  })
})
