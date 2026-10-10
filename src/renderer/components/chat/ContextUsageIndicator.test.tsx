import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUsage } from '@/lib/acp-api'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ContextUsageDetails, ContextUsageIndicator } from './ContextUsageIndicator'

const mobileShellRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellRef.current
}))

/** 40K of a 190K conversation window (200K total minus the 10K bootstrap): 21%. */
function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    used: 50_000,
    size: 200_000,
    baselineUsed: 10_000,
    updatedAt: 1,
    source: 'reported',
    ...overrides
  }
}

const MESSAGES = [{ role: 'user' }, { role: 'assistant' }]
const RING = /Context \d+ percent used/

function ring(): HTMLElement {
  return screen.getByRole('button', { name: RING })
}

function overlayIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

beforeEach(() => {
  mobileShellRef.current = false
  useOverlayStackStore.setState({ stack: [] })
})

afterEach(() => {
  cleanup()
  useOverlayStackStore.setState({ stack: [] })
})

describe('ContextUsageIndicator ring visibility', () => {
  it.each([
    ['usage is missing', null, MESSAGES],
    ['the report is bootstrap-only (no user message yet)', usage(), [{ role: 'assistant' }]],
    ['conversation fill is under 1%', usage({ used: 10_100 }), MESSAGES]
  ])('renders nothing when %s', (_label, value, messages) => {
    const { container } = render(<ContextUsageIndicator usage={value} messages={messages} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the ring with the rounded conversation percent', () => {
    render(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    expect(screen.getByRole('button', { name: 'Context 21 percent used' })).toBeInTheDocument()
  })

  it('keeps the 44px hit-slop on a coarse pointer in a wide pane, and 40px for a fine one', () => {
    render(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    const classes = ring().className.split(/\s+/)

    expect(classes).toEqual(
      expect.arrayContaining([
        'after:-inset-y-1.5',
        '@[400px]:after:-inset-y-1',
        'pointer-coarse:@[400px]:after:-inset-y-1.5'
      ])
    )
  })
})

describe('ContextUsageIndicator on desktop', () => {
  it('opens the popover with the details and renders no sheet', () => {
    render(
      <ContextUsageIndicator
        usage={usage({ cost: { amount: 0.42, currency: 'USD' } })}
        messages={MESSAGES}
      />
    )
    fireEvent.click(ring())

    const popover = screen.getByRole('dialog')
    expect(popover).not.toHaveAttribute('data-sheet')
    expect(document.querySelector('[data-sheet]')).toBeNull()
    expect(within(popover).getByText('Context window')).toBeInTheDocument()
    expect(within(popover).getByText('21% conversation used')).toBeInTheDocument()
    expect(within(popover).getByText(/\/ .* tokens/)).toBeInTheDocument()
    expect(within(popover).getByText(/remaining/)).toBeInTheDocument()
    expect(within(popover).getByText(/Total in context:/)).toBeInTheDocument()
    expect(within(popover).getByText('Reported cost')).toBeInTheDocument()
    expect(within(popover).getByText('Reported by agent')).toBeInTheDocument()
    // No overlay-stack entry: the popover is not part of the mobile back stack.
    expect(overlayIds()).toEqual([])
  })

  it('omits the cost block when the reported cost is not meaningful', () => {
    render(
      <ContextUsageIndicator
        usage={usage({ cost: { amount: 0, currency: 'USD' } })}
        messages={MESSAGES}
      />
    )
    fireEvent.click(ring())
    expect(screen.queryByText('Reported cost')).not.toBeInTheDocument()
  })
})

describe('ContextUsageIndicator on the mobile web shell', () => {
  beforeEach(() => {
    mobileShellRef.current = true
  })

  function renderMobile(value: SessionUsage | null = usage()) {
    return render(<ContextUsageIndicator usage={value} messages={MESSAGES} />)
  }

  it('opens a bottom sheet titled "Context window" with the same lines as the popover', () => {
    renderMobile(usage({ cost: { amount: 0.42, currency: 'USD' } }))
    fireEvent.click(ring())

    const sheet = screen.getByRole('dialog', { name: 'Context window' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(sheet.className).toContain('max-h-[85dvh]')
    expect(sheet.className).toContain('overflow-y-auto')
    expect(sheet.className).toContain('overscroll-contain')
    expect(sheet.className).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
    // The title carries the heading, so the details do not repeat it.
    expect(within(sheet).getAllByText('Context window')).toHaveLength(1)
    expect(within(sheet).getByText('21% conversation used')).toBeInTheDocument()
    expect(within(sheet).getByText(/\/ .* tokens/)).toBeInTheDocument()
    expect(within(sheet).getByText(/remaining/)).toBeInTheDocument()
    expect(within(sheet).getByText(/Total in context:/)).toBeInTheDocument()
    expect(within(sheet).getByText('Reported cost')).toBeInTheDocument()
    expect(within(sheet).getByText('Reported by agent')).toBeInTheDocument()
  })

  it('registers context-details-sheet while open and unregisters on close', () => {
    renderMobile()
    expect(overlayIds()).toEqual([])

    fireEvent.click(ring())
    expect(overlayIds()).toEqual(['context-details-sheet'])

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
  })

  it('returns focus to the ring when the sheet closes with Escape', async () => {
    renderMobile()
    fireEvent.click(ring())
    expect(screen.getByRole('dialog', { name: 'Context window' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
    await waitFor(() => expect(ring()).toHaveFocus())
  })

  it('closes through the overlay stack (system back) and returns focus to the ring', async () => {
    renderMobile()
    fireEvent.click(ring())
    expect(overlayIds()).toEqual(['context-details-sheet'])

    act(() => {
      expect(useOverlayStackStore.getState().closeTopmostOverlay()).toBe(true)
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
    await waitFor(() => expect(ring()).toHaveFocus())
  })

  it('renders no ring, no sheet and no overlay entry when the ring is hidden', () => {
    const { container } = renderMobile(null)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
  })

  it('drops the sheet and its overlay entry when the ring hides while it is open', () => {
    const view = renderMobile()
    fireEvent.click(ring())
    expect(overlayIds()).toEqual(['context-details-sheet'])

    view.rerender(<ContextUsageIndicator usage={null} messages={MESSAGES} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])

    // The ring coming back must not re-open a stale sheet.
    view.rerender(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
  })
})

describe('ContextUsageIndicator when the shell flips under an open sheet', () => {
  it('drops the sheet and its overlay entry when the mobile shell ends, and does not reopen it', () => {
    mobileShellRef.current = true
    const view = render(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    fireEvent.click(ring())
    expect(screen.getByRole('dialog', { name: 'Context window' })).toBeInTheDocument()
    expect(overlayIds()).toEqual(['context-details-sheet'])

    // Desktop takes over: the sheet unmounts, so Back must not keep a phantom entry.
    mobileShellRef.current = false
    view.rerender(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    expect(document.querySelector('[data-sheet]')).toBeNull()
    expect(overlayIds()).toEqual([])

    // The mobile shell returning must not pop the stale sheet open again.
    mobileShellRef.current = true
    view.rerender(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    expect(document.querySelector('[data-sheet]')).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
  })
})

describe('ContextUsageDetails', () => {
  it('shows the heading by default and drops it with showHeading={false}', () => {
    const view = render(<ContextUsageDetails usage={usage()} />)
    expect(screen.getByText('Context window')).toBeInTheDocument()
    view.unmount()

    render(<ContextUsageDetails usage={usage()} showHeading={false} />)
    expect(screen.queryByText('Context window')).not.toBeInTheDocument()
    expect(screen.getByText('Reported by agent')).toBeInTheDocument()
  })
})
