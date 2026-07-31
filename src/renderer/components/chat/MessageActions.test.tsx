import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageActions } from './MessageActions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/copy-text', () => ({
  copyText: vi.fn(async () => true)
}))

function renderActions(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('MessageActions', () => {
  it('is hover-hidden by default', () => {
    const { container } = renderActions(<MessageActions text="hello" align="start" />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-0')
    expect(bar).toHaveClass('group-hover/message:opacity-100')
    expect(bar).not.toHaveClass('opacity-100')
  })

  it('stays visible when pinned', () => {
    const { container } = renderActions(<MessageActions text="hello" align="start" pinned />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-100')
    expect(bar).not.toHaveClass('opacity-0')
  })

  it('renders copy button with accessible label', () => {
    renderActions(<MessageActions text="hello" align="end" pinned />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('uses compact Streamdown-sized action buttons', () => {
    renderActions(<MessageActions text="hello" align="start" pinned />)
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass('size-6')
  })

  it('renders retry when provided', () => {
    renderActions(<MessageActions text="hello" align="start" pinned onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
