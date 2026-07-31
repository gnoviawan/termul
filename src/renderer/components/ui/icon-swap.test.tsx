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
})
