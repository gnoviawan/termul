import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetBrowserHostForTesting,
  type BrowserHost,
  registerBrowserHost
} from '@/lib/browser-host'
import type { MermaidRender } from '../../browser/mermaid-render'
import { _resetMermaidCacheForTesting, canDrawMermaid, drawMermaid } from '../mermaid'

function hostAnswering(answer: (source: string) => MermaidRender): string[] {
  const asked: string[] = []
  const host = {
    renderMermaid: async (source: string) => {
      asked.push(source)
      return answer(source)
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
      width: 9,
      height: 3
    }))
    const first = await drawMermaid('flowchart LR\n  A --> B')
    const again = await drawMermaid('flowchart LR\n  A --> B')
    expect(first).toEqual({ ok: true, png: 'data:image/png;base64,AA', width: 9, height: 3 })
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
