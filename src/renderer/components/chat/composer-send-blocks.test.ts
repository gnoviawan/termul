import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@/lib/acp-api'
import { withBrowserShares } from './composer-send-blocks'

const share: ContentBlock = {
  type: 'resource_link',
  uri: 'termul-browser-share://token',
  name: 'Browser page'
}

describe('withBrowserShares', () => {
  it('leaves a send without shares as it is', () => {
    const send = { kind: 'text' as const, text: 'hi' }
    expect(withBrowserShares(send, [])).toBe(send)
    expect(withBrowserShares(null, [])).toBeNull()
  })

  it('sends shares alone, after text, and in both wire and display', () => {
    expect(withBrowserShares(null, [share])).toEqual({ kind: 'blocks', wire: [share] })
    expect(withBrowserShares({ kind: 'text', text: 'look' }, [share])).toEqual({
      kind: 'blocks',
      wire: [{ type: 'text', text: 'look' }, share]
    })
    expect(
      withBrowserShares(
        {
          kind: 'blocks',
          wire: [{ type: 'text', text: 'wire' }],
          display: [{ type: 'text', text: 'display' }]
        },
        [share]
      )
    ).toEqual({
      kind: 'blocks',
      wire: [{ type: 'text', text: 'wire' }, share],
      display: [{ type: 'text', text: 'display' }, share]
    })
  })
})
