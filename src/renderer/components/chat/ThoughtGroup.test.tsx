import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/stores/acp-store'
import { ThoughtGroup } from './ThoughtGroup'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

// jsdom has no real layout, so the hook's live-edge math is driven by stubbing
// scroll geometry + scrollTo and a controllable ResizeObserver (the global
// setup mock is a no-op that never fires its callback).

interface ScrollGeometry {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

let roCallback: ((entries: unknown[]) => void) | null = null
let scrollToMock: ReturnType<typeof vi.fn>

class ControllableResizeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    roCallback = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {
    roCallback = null
  }
}

function setScrollGeometry(el: Element, geo: ScrollGeometry): void {
  let top = geo.scrollTop
  Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    },
    configurable: true
  })
}

function thought(id: string, text: string, streaming: boolean): ChatMessage {
  return {
    id,
    role: 'thought',
    blocks: [{ type: 'text', text }],
    streaming,
    timestamp: 0
  }
}

function scrollBox(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[class*="overflow-y-auto"]')
  if (!el) throw new Error('scroll box not found')
  return el as HTMLElement
}

beforeEach(() => {
  roCallback = null
  scrollToMock = vi.fn()
  // jsdom may not implement Element.scrollTo; stub it so scrollToBottom works.
  window.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver
  HTMLElement.prototype.scrollTo = scrollToMock
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ThoughtGroup', () => {
  it('shows Thinking… and expanded content while streaming at live tail', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'Checking the codebase…', true)]} isLiveTail />
    )
    expect(screen.getByText(/Thinking/)).toBeInTheDocument()
    const shimmer = container.querySelector('.t-shimmer')
    expect(shimmer).toBeInTheDocument()
    expect(shimmer).toHaveAttribute('data-text', 'Thinking…')
    await waitFor(() => {
      expect(screen.getByText('Checking the codebase…')).toBeInTheDocument()
    })
  })

  it('shows Thought · N lines when settled', () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'Line one\nLine two', false)]} isLiveTail={false} />
    )
    expect(screen.getByText(/Thought/)).toBeInTheDocument()
    expect(container.querySelector('.tabular-nums')).toHaveTextContent('2 lines')
  })

  it('joins multiple thought chunks when expanded via trigger click', async () => {
    render(
      <ThoughtGroup
        messages={[thought('t1', 'First chunk', false), thought('t2', 'Second chunk', false)]}
        isLiveTail={false}
      />
    )
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText(/First chunk/)).toBeInTheDocument()
      expect(screen.getByText(/Second chunk/)).toBeInTheDocument()
    })
  })

  it('allows manual toggle after user interaction', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Hidden until open', false)]} isLiveTail={false} />
    )
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Hidden until open')).toBeInTheDocument()
    })
  })

  it('renders content inside a scrollable box with max-height by default', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // The content container should have max-h class
    const contentDiv = screen
      .getByText('Some thinking text')
      .closest('div[class*="overflow-y-auto"]')
    expect(contentDiv).toBeInTheDocument()
    expect(contentDiv?.className).toContain('max-h-[200px]')
    expect(contentDiv?.className).toContain('overflow-y-auto')
  })

  it('shows More/Less expand toggle button', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // "More" button should be visible
    expect(screen.getByText('More')).toBeInTheDocument()
  })

  it('toggles between More and Less on click', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // Click "More" to expand
    const moreButton = screen.getByText('More')
    fireEvent.click(moreButton)
    expect(screen.getByText('Less')).toBeInTheDocument()
    // The content container should no longer have max-h
    const contentDiv = screen
      .getByText('Some thinking text')
      .closest('div[class*="overflow-y-auto"]')
    expect(contentDiv?.className).not.toContain('max-h-[200px]')
    // Click "Less" to collapse
    fireEvent.click(screen.getByText('Less'))
    expect(screen.getByText('More')).toBeInTheDocument()
    const contentDivAgain = screen
      .getByText('Some thinking text')
      .closest('div[class*="overflow-y-auto"]')
    expect(contentDivAgain?.className).toContain('max-h-[200px]')
  })

  it('resets expanded state when collapsible is closed and reopened', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open and expand
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('More'))
    expect(screen.getByText('Less')).toBeInTheDocument()
    // Close the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    // Re-open — should be back to "More" (collapsed box)
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    expect(screen.getByText('More')).toBeInTheDocument()
  })

  it('auto-scrolls to bottom while streaming when pinned to the live edge', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    const box = scrollBox(container)
    // Pinned to the bottom (distance 0 <= threshold), overflowing.
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 })
    // Drive the ResizeObserver follow callback (content grew).
    act(() => {
      roCallback?.([])
    })
    expect(box.scrollTop).toBe(500)
  })

  it('stops following and shows jump-to-latest when the reader scrolls away during streaming', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    const box = scrollBox(container)
    // Reader scrolled up: distance 300 > threshold.
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
    fireEvent.scroll(box)
    await waitFor(() => {
      expect(screen.getByLabelText('Jump to latest thinking')).toBeInTheDocument()
    })
    // Content grows while scrolled away: follow must NOT move the box.
    act(() => {
      roCallback?.([])
    })
    expect(box.scrollTop).toBe(0)
  })

  it('clicking jump-to-latest scrolls to the bottom and resumes follow', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    const box = scrollBox(container)
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
    fireEvent.scroll(box)
    const jumpButton = await screen.findByLabelText('Jump to latest thinking')
    fireEvent.click(jumpButton)
    // Reduced-motion mock => behavior: 'auto'
    expect(scrollToMock).toHaveBeenCalledWith({ top: 500, behavior: 'auto' })
    // Button hides and follow resumes on next resize.
    await waitFor(() => {
      expect(screen.queryByLabelText('Jump to latest thinking')).not.toBeInTheDocument()
    })
    setScrollGeometry(box, { scrollHeight: 600, clientHeight: 200, scrollTop: 400 })
    act(() => {
      roCallback?.([])
    })
    expect(box.scrollTop).toBe(600)
  })

  it('does not auto-scroll when expanded (no max-height scroll context)', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    // Expand — removes max-height, follow disabled.
    fireEvent.click(screen.getByText('More'))
    expect(screen.getByText('Less')).toBeInTheDocument()
    const box = scrollBox(container)
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
    act(() => {
      roCallback?.([])
    })
    expect(box.scrollTop).toBe(0)
    expect(scrollToMock).not.toHaveBeenCalled()
  })

  it('does not re-pin when collapsing back from expanded mid-stream', async () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    const box = scrollBox(container)
    // Reader scrolled away from the bottom during streaming.
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
    fireEvent.scroll(box)
    await waitFor(() => {
      expect(screen.getByLabelText('Jump to latest thinking')).toBeInTheDocument()
    })
    // Expand to read earlier content, then collapse back mid-stream.
    fireEvent.click(screen.getByText('More'))
    fireEvent.click(screen.getByText('Less'))
    // Collapsing must NOT silently re-pin: scroll position preserved + jump
    // button still offered (reader never asked to resume following).
    await waitFor(() => {
      expect(screen.getByLabelText('Jump to latest thinking')).toBeInTheDocument()
    })
    expect(box.scrollTop).toBe(0)
  })

  it('stops following once streaming ends (no auto-scroll on later content change)', async () => {
    const { rerender, container } = render(
      <ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), true)]} isLiveTail />
    )
    await waitFor(() => {
      expect(screen.getByText(/thinking/)).toBeInTheDocument()
    })
    const box = scrollBox(container)
    setScrollGeometry(box, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
    // Stream settles: streaming flag false, still live tail.
    rerender(<ThoughtGroup messages={[thought('t1', 'thinking…'.repeat(200), false)]} isLiveTail />)
    // No jump button once not streaming.
    await waitFor(() => {
      expect(screen.queryByLabelText('Jump to latest thinking')).not.toBeInTheDocument()
    })
    // Content change after settle must not auto-scroll.
    setScrollGeometry(box, { scrollHeight: 700, clientHeight: 200, scrollTop: 0 })
    act(() => {
      roCallback?.([])
    })
    expect(box.scrollTop).toBe(0)
    expect(scrollToMock).not.toHaveBeenCalled()
  })
})
