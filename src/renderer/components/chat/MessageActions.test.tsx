import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageActions } from './MessageActions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/copy-text', () => ({
  copyText: vi.fn(async () => true)
}))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    // Snap swaps so Copy→Check is assertable without waiting on spring/blur.
    useReducedMotion: () => true
  }
})

function renderActions(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('MessageActions', () => {
  it('is hover-hidden on fine pointers by default', () => {
    const { container } = renderActions(<MessageActions text="hello" align="start" />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-100')
    expect(bar).toHaveClass('pointer-fine:opacity-0')
    expect(bar).toHaveClass('pointer-fine:group-hover/message:opacity-100')
  })

  it('stays visible when pinned', () => {
    const { container } = renderActions(<MessageActions text="hello" align="start" pinned />)
    const bar = container.firstElementChild
    expect(bar).toHaveClass('opacity-100')
    expect(bar).not.toHaveClass('pointer-fine:opacity-0')
  })

  it('renders copy button with accessible label', () => {
    renderActions(<MessageActions text="hello" align="end" pinned />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('uses 44px action slots without overlapping expanded hit targets', () => {
    renderActions(<MessageActions text="hello" align="start" pinned />)
    const copy = screen.getByRole('button', { name: 'Copy' })
    expect(copy).toHaveClass('size-11')
    expect(copy.className).not.toMatch(/after:-inset/)
  })

  it('renders retry when provided', () => {
    renderActions(<MessageActions text="hello" align="start" pinned onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('swaps Copy to Check with text-success after a successful copy', async () => {
    renderActions(<MessageActions text="hello" align="start" pinned />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    })
    const check = document.querySelector('.lucide-check')
    expect(check).toBeTruthy()
    expect(check?.classList.contains('text-success')).toBe(true)
    expect(document.querySelector('.lucide-copy')).toBeNull()
  })
})
