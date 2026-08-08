import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IconSwap } from './icon-swap'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

describe('IconSwap', () => {
  it('renders children', () => {
    render(
      <IconSwap iconKey="copy">
        <span>Copy icon</span>
      </IconSwap>
    )
    expect(screen.getByText('Copy icon')).toBeInTheDocument()
  })

  it('replaces children when iconKey changes under reduced motion', () => {
    const { rerender } = render(
      <IconSwap iconKey="copy">
        <span>Copy icon</span>
      </IconSwap>
    )
    expect(screen.getByText('Copy icon')).toBeInTheDocument()
    rerender(
      <IconSwap iconKey="check">
        <span>Check icon</span>
      </IconSwap>
    )
    expect(screen.getByText('Check icon')).toBeInTheDocument()
    expect(screen.queryByText('Copy icon')).not.toBeInTheDocument()
  })
})
