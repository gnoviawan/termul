import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageActions } from './MessageActions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/copy-text', () => ({
  copyText: vi.fn(async () => true)
}))

describe('MessageActions', () => {
  it('is hover-hidden by default', () => {
    const { container } = render(<MessageActions text="hello" align="start" />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-0')
    expect(bar).toHaveClass('group-hover/message:opacity-100')
    expect(bar).not.toHaveClass('opacity-100')
  })

  it('stays visible when pinned', () => {
    const { container } = render(<MessageActions text="hello" align="start" pinned />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-100')
    expect(bar).not.toHaveClass('opacity-0')
  })

  it('renders copy button with accessible label', () => {
    render(<MessageActions text="hello" align="end" pinned />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('renders retry when provided', () => {
    render(<MessageActions text="hello" align="start" pinned onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
