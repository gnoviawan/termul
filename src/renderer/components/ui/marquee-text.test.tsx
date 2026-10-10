import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'

vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

import { MarqueeText } from './marquee-text'

// jsdom reports every element's scrollWidth/clientWidth as 0, so tests stub
// both getters on the prototype. Mutable reads let a test change the widths
// mid-render to exercise re-measurement.
const widths = { scroll: 0, client: 0 }
let scrollWidthSpy: ReturnType<typeof vi.spyOn> | undefined
let clientWidthSpy: ReturnType<typeof vi.spyOn> | undefined

/** Make every element report `scroll`/`client` for the mounted MarqueeText. */
function fakeWidths(scroll: number, client: number): void {
  widths.scroll = scroll
  widths.client = client
  scrollWidthSpy ??= vi
    .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
    .mockImplementation(() => widths.scroll)
  clientWidthSpy ??= vi
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockImplementation(() => widths.client)
}

beforeEach(() => {
  resetFramerMotionTestState()
  widths.scroll = 0
  widths.client = 0
})

afterEach(() => {
  scrollWidthSpy?.mockRestore()
  clientWidthSpy?.mockRestore()
  scrollWidthSpy = undefined
  clientWidthSpy = undefined
})

describe('MarqueeText', () => {
  it('renders a plain truncate span when the text fits (jsdom: no overflow)', () => {
    render(<MarqueeText text="short title" />)

    const el = screen.getByText('short title')
    expect(el).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(el.querySelector('.termul-marquee')).toBeNull()
  })

  it('marquees an overflowing title with the measured distance inline', () => {
    fakeWidths(300, 100)
    render(<MarqueeText text="a very long chat title that overflows" />)

    const runner = document.querySelector<HTMLElement>('.termul-marquee')
    expect(runner).not.toBeNull()
    expect(runner?.style.getPropertyValue('--termul-marquee-distance')).toBe('200px')
    // Duration scales with distance but stays inside the clamp band.
    const duration = Number(
      runner?.style.getPropertyValue('--termul-marquee-duration').replace('ms', '')
    )
    expect(duration).toBeGreaterThanOrEqual(6000)
    expect(duration).toBeLessThanOrEqual(16000)
    // The viewport clips; the runner scrolls inside it.
    expect(runner?.parentElement).toHaveClass(
      'min-w-0',
      'flex-1',
      'overflow-hidden',
      'whitespace-nowrap'
    )
  })

  it('keeps the full text as the only copy (aria stays on the row label)', () => {
    fakeWidths(300, 100)
    render(<MarqueeText text="a very long chat title that overflows" />)

    expect(screen.getAllByText('a very long chat title that overflows')).toHaveLength(1)
  })

  it('never marquees under reduced motion — overflow falls back to truncate', () => {
    framerMotionTestState.reducedMotion.current = true
    fakeWidths(300, 100)
    render(<MarqueeText text="a very long chat title that overflows" />)

    const el = screen.getByText('a very long chat title that overflows')
    expect(el).toHaveClass('truncate')
    expect(document.querySelector('.termul-marquee')).toBeNull()
  })

  it('re-measures when the text prop changes', () => {
    fakeWidths(300, 100)
    const { rerender } = render(<MarqueeText text="first title" />)

    // New text that fits the viewport → marquee drops back to truncate.
    widths.scroll = 100
    rerender(<MarqueeText text="fits" />)
    expect(screen.getByText('fits')).toHaveClass('truncate')
    expect(document.querySelector('.termul-marquee')).toBeNull()

    // New text that overflows → marquee mounts with the fresh distance.
    widths.scroll = 260
    rerender(<MarqueeText text="second longer title that now overflows" />)
    const runner = document.querySelector<HTMLElement>('.termul-marquee')
    expect(runner?.style.getPropertyValue('--termul-marquee-distance')).toBe('160px')
  })

  it('passes className and span props through to the label', () => {
    render(<MarqueeText text="tinted" className="text-muted-foreground" title="full" />)

    const el = screen.getByText('tinted')
    expect(el).toHaveClass('text-muted-foreground')
    expect(el).toHaveAttribute('title', 'full')
    expect(el).toHaveAttribute('data-slot', 'marquee-text')
  })
})
