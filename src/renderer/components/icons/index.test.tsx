import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AlertCircle, Search, Square } from './index'

describe('Termul functional icons', () => {
  it('inherits the UI color and accepts size and stroke overrides', () => {
    const { container } = render(
      <>
        <Search size={16} strokeWidth={2} />
        <AlertCircle aria-label="Connection warning" />
      </>
    )
    const [search, alert] = container.querySelectorAll('svg')

    expect(search).toHaveAttribute('width', '16')
    expect(search).toHaveAttribute('height', '16')
    expect(search).toHaveAttribute('stroke-width', '2')
    expect(search).toHaveAttribute('stroke', 'currentColor')
    expect(search.innerHTML).not.toContain('#252525')
    expect(search).toHaveAttribute('aria-hidden', 'true')
    expect(alert).toHaveAttribute('aria-label', 'Connection warning')
    expect(alert).not.toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps the filled stop square', () => {
    const { container } = render(<Square size={10} fill="currentColor" strokeWidth={0} />)
    const square = container.querySelector('svg')

    expect(square).toHaveAttribute('data-termul-icon', 'Square')
    expect(square).toHaveAttribute('width', '10')
    expect(square).toHaveAttribute('fill', 'currentColor')
    expect(square).toHaveAttribute('stroke-width', '0')
    expect(square?.querySelector('rect')).not.toBeNull()
  })
})
