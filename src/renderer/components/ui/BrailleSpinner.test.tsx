import { render, screen } from '@testing-library/react'
import spinners from 'unicode-animations'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BrailleSpinner } from './BrailleSpinner'

const mockUseReducedMotion = vi.fn(() => false)

vi.mock('framer-motion', () => ({
  useReducedMotion: () => mockUseReducedMotion()
}))

describe('BrailleSpinner', () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false)
  })

  it('renders a frame from the braille spinner set', () => {
    render(<BrailleSpinner data-testid="spinner" />)
    const el = screen.getByTestId('spinner')
    expect(spinners.braille.frames).toContain(el.textContent)
  })

  it('shows the first frame when reduced motion is enabled', () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(<BrailleSpinner data-testid="spinner" />)
    expect(screen.getByTestId('spinner').textContent).toBe(spinners.braille.frames[0])
  })
})
