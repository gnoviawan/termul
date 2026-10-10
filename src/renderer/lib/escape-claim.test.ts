import { describe, expect, it } from 'vitest'
import { claimEscape, isEscapeClaimed } from './escape-claim'

describe('escape-claim', () => {
  it('reports an Esc nobody claimed as unclaimed', () => {
    expect(isEscapeClaimed(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  })

  it('reports a claimed Esc as claimed, for the very same event only', () => {
    const claimed = new KeyboardEvent('keydown', { key: 'Escape' })
    const other = new KeyboardEvent('keydown', { key: 'Escape' })

    claimEscape(claimed)

    expect(isEscapeClaimed(claimed)).toBe(true)
    expect(isEscapeClaimed(other)).toBe(false)
  })

  it('does not take a prevented Esc for a claimed one', () => {
    // A Radix layer still animating out prevents the Esc it receives, above nothing.
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    event.preventDefault()

    expect(event.defaultPrevented).toBe(true)
    expect(isEscapeClaimed(event)).toBe(false)
  })
})
