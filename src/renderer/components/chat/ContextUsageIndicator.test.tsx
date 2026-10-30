import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUsage } from '@/lib/acp-api'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ContextUsageDetails, ContextUsageIndicator } from './ContextUsageIndicator'

const mobileShellRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellRef.current
}))

/** 50K of 200K shown (25%); 40K of the 190K conversation window (21%) drives the warning. */
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
const RING = /^Context \d+%/

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

  it('names the ring with the shown percent and the tokens used', () => {
    render(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    expect(
      screen.getByRole('button', { name: 'Context 25%, 50K of 200K tokens' })
    ).toBeInTheDocument()
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
    expect(within(popover).getByText('25% used')).toBeInTheDocument()
    expect(within(popover).getByText('Setup')).toBeInTheDocument()
    expect(within(popover).getByText('Conversation')).toBeInTheDocument()
    expect(within(popover).getByTestId('context-left')).toHaveTextContent('150K left')
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
    expect(within(sheet).getByText('25% used')).toBeInTheDocument()
    expect(within(sheet).getByText('Setup')).toBeInTheDocument()
    expect(within(sheet).getByText('Conversation')).toBeInTheDocument()
    expect(within(sheet).getByTestId('context-left')).toHaveTextContent('150K left')
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

describe('ContextUsageIndicator warning and Compact', () => {
  /** 160K of a 190K conversation window: 84%. */
  const high = () => usage({ used: 170_000 })

  it('turns on the warning at 80% and keeps it until usage drops below 78%', () => {
    const view = render(<ContextUsageIndicator usage={high()} messages={MESSAGES} />)
    expect(ring()).toHaveAttribute('data-warning', 'true')
    expect(ring()).toHaveAccessibleName(/nearing the limit/)

    // 79%: inside the hysteresis band, so the warning stays.
    view.rerender(<ContextUsageIndicator usage={usage({ used: 160_100 })} messages={MESSAGES} />)
    expect(ring()).toHaveAttribute('data-warning', 'true')

    // 77%: below the off threshold.
    view.rerender(<ContextUsageIndicator usage={usage({ used: 156_300 })} messages={MESSAGES} />)
    expect(ring()).not.toHaveAttribute('data-warning')
    // The shown percent counts setup (78%); the warning uses the conversation percent (77%).
    expect(ring()).toHaveAccessibleName('Context 78%, 156.3K of 200K tokens')
  })

  it('shows "Nearing the limit" in the footer when the warning is on', () => {
    render(<ContextUsageIndicator usage={high()} messages={MESSAGES} />)
    fireEvent.click(ring())
    expect(screen.getByTestId('context-left')).toHaveTextContent('Nearing the limit · 30K left')
  })

  it('hides Compact when the agent offers no compact command', () => {
    render(<ContextUsageIndicator usage={usage()} messages={MESSAGES} />)
    fireEvent.click(ring())
    expect(screen.queryByRole('button', { name: 'Compact' })).not.toBeInTheDocument()
  })

  it('sends compact once and shows Compacting… until the turn ends', () => {
    const onCompact = vi.fn()
    const signals = { connected: true, activeTurn: false, compaction: null }
    const view = render(
      <ContextUsageIndicator
        usage={usage()}
        messages={MESSAGES}
        onCompact={onCompact}
        compactSignals={signals}
      />
    )
    fireEvent.click(ring())
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
    expect(onCompact).toHaveBeenCalledTimes(1)
    const pending = screen.getByRole('button', { name: 'Compacting…' })
    expect(pending).toBeDisabled()

    view.rerender(
      <ContextUsageIndicator
        usage={usage()}
        messages={MESSAGES}
        onCompact={onCompact}
        compactSignals={{ ...signals, activeTurn: true }}
      />
    )
    expect(screen.getByRole('button', { name: 'Compacting…' })).toBeInTheDocument()

    view.rerender(
      <ContextUsageIndicator
        usage={usage()}
        messages={MESSAGES}
        onCompact={onCompact}
        compactSignals={signals}
      />
    )
    expect(screen.getByRole('button', { name: 'Compact' })).toBeEnabled()
  })

  it('gives up after 60 seconds and shows the failure line', () => {
    vi.useFakeTimers()
    try {
      render(
        <ContextUsageIndicator
          usage={usage()}
          messages={MESSAGES}
          onCompact={vi.fn()}
          compactSignals={{ connected: true, activeTurn: false, compaction: null }}
        />
      )
      fireEvent.click(ring())
      fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(screen.getByRole('button', { name: 'Compact' })).toBeEnabled()
      expect(screen.getByText("Compact didn't finish")).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends compact only once when two clicks land in the same tick', () => {
    const onCompact = vi.fn()
    render(
      <ContextUsageIndicator
        usage={usage()}
        messages={MESSAGES}
        onCompact={onCompact}
        compactSignals={{ connected: true, activeTurn: false, compaction: null }}
      />
    )
    fireEvent.click(ring())
    const button = screen.getByRole('button', { name: 'Compact' })
    act(() => {
      button.click()
      button.click()
    })
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('does not time out while the agent reports compaction running', () => {
    vi.useFakeTimers()
    try {
      const props = { usage: usage(), messages: MESSAGES, onCompact: vi.fn() }
      const view = render(
        <ContextUsageIndicator
          {...props}
          compactSignals={{ connected: true, activeTurn: false, compaction: null }}
        />
      )
      fireEvent.click(ring())
      fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
      view.rerender(
        <ContextUsageIndicator
          {...props}
          compactSignals={{ connected: true, activeTurn: true, compaction: 'started' }}
        />
      )
      act(() => {
        vi.advanceTimersByTime(90_000)
      })
      expect(screen.getByRole('button', { name: 'Compacting…' })).toBeInTheDocument()
      expect(screen.queryByText("Compact didn't finish")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
