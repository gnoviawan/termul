import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { copyText } from '@/lib/copy-text'
import { MessageActions, resolveMessageActionsMode, supportsLongPressMenu } from './MessageActions'

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

  it('uses compact 24px slots with expanded ~44px pseudo-element hit areas (#859)', () => {
    renderActions(<MessageActions text="hello" align="start" pinned />)
    const copy = screen.getByRole('button', { name: 'Copy' })
    expect(copy).toHaveClass('size-6')
    // The invisible ::after grows the tap target without changing layout.
    expect(copy.className).toMatch(/after:-inset-2\.5/)
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
    const check = document.querySelector('svg[data-termul-icon="Check"]')
    expect(check).toBeTruthy()
    expect(check?.classList.contains('text-success')).toBe(true)
    expect(document.querySelector('svg[data-termul-icon="Copy"]')).toBeNull()
  })
})

describe('MessageActions reveal="focus" (mobile shell, option A)', () => {
  function focusRow(props: { pinned?: boolean } = {}): HTMLElement {
    const { container } = renderActions(
      <MessageActions text="hello" align="start" reveal="focus" {...props} />
    )
    return container.firstElementChild as HTMLElement
  }

  it('is hidden and inert at rest, with no bare at-rest opacity-100', () => {
    const row = focusRow()
    expect(row).toHaveClass('opacity-0')
    expect(row).toHaveClass('pointer-events-none')
    expect(row).not.toHaveClass('opacity-100')
    expect(row).not.toHaveClass('pointer-events-auto')
    // The fine-pointer hide of the default mode is not needed: it is already hidden.
    expect(row).not.toHaveClass('pointer-fine:opacity-0')
  })

  it('reveals (and re-enables taps) under message focus-visible, row focus-within and fine-pointer hover', () => {
    const row = focusRow()
    expect(row).toHaveClass('group-focus-visible/message:opacity-100')
    expect(row).toHaveClass('group-focus-visible/message:pointer-events-auto')
    expect(row).toHaveClass('focus-within:opacity-100')
    expect(row).toHaveClass('focus-within:pointer-events-auto')
    expect(row).toHaveClass('pointer-fine:group-hover/message:opacity-100')
    expect(row).toHaveClass('pointer-fine:group-hover/message:pointer-events-auto')
  })

  it('ignores pinned: focus mode stays hidden at rest', () => {
    const pinnedRow = focusRow({ pinned: true })
    expect(pinnedRow).toHaveClass('opacity-0')
    expect(pinnedRow).toHaveClass('pointer-events-none')
    expect(pinnedRow).not.toHaveClass('opacity-100')
  })

  it('keeps the row in the accessibility tree and keeps its alignment classes', () => {
    renderActions(<MessageActions text="hello" align="end" reveal="focus" onEdit={() => {}} />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    const row = screen.getByRole('button', { name: 'Copy' }).closest('.transition-opacity')
    expect(row).toHaveClass('justify-end', '-mr-1')
  })

  it('leaves the default hover mode untouched', () => {
    const { container } = renderActions(<MessageActions text="hello" align="end" />)
    expect((container.firstElementChild as HTMLElement).className).toBe(
      'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100 opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 justify-end -mr-1'
    )
  })
})

describe('MessageActions copy', () => {
  afterEach(() => {
    vi.mocked(copyText).mockImplementation(async () => true)
    vi.mocked(toast.error).mockClear()
  })

  it('shows the Failed to copy toast when the clipboard write fails', async () => {
    vi.mocked(copyText).mockImplementationOnce(async () => false)
    renderActions(<MessageActions text="hello" align="start" pinned />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to copy'))
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('is a silent no-op for empty text', async () => {
    vi.mocked(copyText).mockClear()
    renderActions(<MessageActions text="" align="start" pinned />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    // Let any (unexpected) promise continuation run before asserting.
    await Promise.resolve()
    expect(copyText).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })
})

describe('resolveMessageActionsMode', () => {
  it.each([
    [false, true, 'desktop'],
    [false, false, 'desktop'],
    [true, true, 'focus-reveal'],
    [true, false, 'visible-fallback']
  ] as const)('mobile shell=%s, long-press supported=%s -> %s', (shell, supported, expected) => {
    expect(resolveMessageActionsMode(shell, supported)).toBe(expected)
  })
})

describe('supportsLongPressMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true when Pointer Events exist', () => {
    expect(typeof window.PointerEvent).toBe('function')
    expect(supportsLongPressMenu()).toBe(true)
  })

  it('is false when PointerEvent is unavailable', () => {
    vi.stubGlobal('PointerEvent', undefined)
    expect(window.PointerEvent).toBeUndefined()
    expect(supportsLongPressMenu()).toBe(false)
  })
})
