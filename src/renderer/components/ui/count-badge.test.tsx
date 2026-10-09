import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CountBadge } from './count-badge'

describe('CountBadge', () => {
  it('renders the count on the primary fill', () => {
    render(<CountBadge count={7} />)
    expect(screen.getByText('7')).toHaveClass('bg-primary-fill', 'text-primary-foreground')
  })

  it('caps the label at max', () => {
    render(<CountBadge count={120} max={99} />)
    expect(screen.getByText('99+')).toBeInTheDocument()
  })

  it('shows the exact count at max and without a cap', () => {
    const { rerender } = render(<CountBadge count={99} max={99} />)
    expect(screen.getByText('99')).toBeInTheDocument()
    rerender(<CountBadge count={120} />)
    expect(screen.getByText('120')).toBeInTheDocument()
  })

  it('merges call-site sizing classes', () => {
    render(<CountBadge count={3} className="h-4 text-3xs" data-testid="badge" />)
    expect(screen.getByTestId('badge')).toHaveClass('h-4', 'text-3xs', 'rounded-full')
  })
})
