import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { RowReveal } from './RowReveal'

const reducedMotion = vi.hoisted(() => ({ value: false }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => reducedMotion.value
  }
})

function revealOf(text: string): HTMLElement | null {
  return screen.getByText(text).closest('[data-row-reveal]')
}

describe('RowReveal', () => {
  it('renders history rows in place without a reveal', () => {
    reducedMotion.value = false
    render(<RowReveal animate={false}>History row</RowReveal>)
    expect(revealOf('History row')).toHaveAttribute('data-row-reveal', 'static')
  })

  it('grows the track from 0fr for a live row', () => {
    reducedMotion.value = false
    render(<RowReveal animate>Live row</RowReveal>)
    const shell = revealOf('Live row')
    expect(shell).toHaveAttribute('data-row-reveal', 'revealing')
    expect(shell?.style.gridTemplateRows).toBe('0fr')
  })

  it('still reveals inside an open collapse shell that skips its own initial animation', () => {
    reducedMotion.value = false
    render(
      <CollapseExpandMotion open>
        <RowReveal animate>Nested row</RowReveal>
      </CollapseExpandMotion>
    )
    expect(revealOf('Nested row')?.style.gridTemplateRows).toBe('0fr')
  })

  it('appears instantly under reduced motion', () => {
    reducedMotion.value = true
    render(<RowReveal animate>Reduced row</RowReveal>)
    expect(revealOf('Reduced row')).toHaveAttribute('data-row-reveal', 'static')
  })
})
