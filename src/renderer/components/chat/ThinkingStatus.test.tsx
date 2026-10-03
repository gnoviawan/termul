import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThinkingStatus } from './ThinkingStatus'

const { reducedMotion } = vi.hoisted(() => ({
  reducedMotion: { current: false }
}))

vi.mock('framer-motion', () => ({
  useReducedMotion: () => reducedMotion.current
}))

describe('ThinkingStatus', () => {
  beforeEach(() => {
    reducedMotion.current = false
  })

  it('shimmers the holding line', () => {
    const { container } = render(<ThinkingStatus text="Thinking…" shimmer />)
    const line = container.querySelector('.t-think-text')
    expect(line).toHaveAttribute('data-text', 'Thinking…')
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
    expect(container.querySelector('.t-think')).not.toHaveClass('is-settled')
  })

  it('settles without a shimmer and swaps the outgoing line', () => {
    const { container, rerender } = render(<ThinkingStatus text="Thinking…" shimmer />)
    rerender(<ThinkingStatus text="Thought" shimmer={false} />)
    expect(container.querySelector('.is-exit')).toHaveAttribute('data-text', 'Thinking…')
    expect(container.querySelector('.is-enter-start')).toHaveAttribute('data-text', 'Thought')
    expect(container.querySelector('.t-think')).toHaveClass('is-settled')
  })

  it('snaps to the new line under reduced motion', () => {
    reducedMotion.current = true
    const { container, rerender } = render(<ThinkingStatus text="Working…" shimmer />)
    rerender(<ThinkingStatus text="Worked" shimmer={false} />)
    expect(container.querySelector('.is-exit')).not.toBeInTheDocument()
    expect(container.querySelector('.t-think-text')).toHaveAttribute('data-text', 'Worked')
  })
})
