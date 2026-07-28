import { describe, expect, it } from 'vitest'
import { bubbleEnter, iconPop, staggerChild } from './chat-motion'

describe('chat-motion', () => {
  it('bubbleEnter start omits scale on initial (y-only agent prose enter)', () => {
    const { initial } = bubbleEnter('start', false)
    expect(initial).not.toHaveProperty('scale')
    expect(initial).toMatchObject({ opacity: 0, y: 8, x: -6 })
  })

  it('bubbleEnter end keeps scale for user bubbles', () => {
    const { initial } = bubbleEnter('end', false)
    expect(initial).toMatchObject({ scale: 0.96 })
  })

  it('staggerChild applies incremental delay', () => {
    const a = staggerChild(0, false, 'start')
    const b = staggerChild(0.08, false, 'start')
    expect(a.transition).toMatchObject({ delay: 0 })
    expect(b.transition).toMatchObject({ delay: 0.08 })
  })

  it('iconPop uses blur and 0.25 scale per contextual icon pattern', () => {
    const { initial } = iconPop(false)
    expect(initial).toMatchObject({ opacity: 0, scale: 0.25, filter: 'blur(4px)' })
  })
})
