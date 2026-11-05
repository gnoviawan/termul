import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RollingText } from './RollingText'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('RollingText', () => {
  it('gives screen readers the plain text and hides the digit columns', () => {
    const { container } = render(<RollingText text="47K left" />)
    expect(screen.getByText('47K left')).toHaveClass('sr-only')
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('moves each digit column to its value', () => {
    const { container } = render(<RollingText text="3" />)
    const column = container.querySelector<HTMLElement>('[aria-hidden="true"] .flex-col')
    expect(column?.style.transform).toBe('translateY(-30%)')
  })

  it('shows rapid updates at most every 250ms and always lands on the last one', () => {
    const view = render(<RollingText text="10% used" />)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    view.rerender(<RollingText text="11% used" />)
    expect(screen.getByText('11% used')).toBeInTheDocument()

    view.rerender(<RollingText text="12% used" />)
    view.rerender(<RollingText text="13% used" />)
    expect(screen.getByText('11% used')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.getByText('13% used')).toBeInTheDocument()
  })
})
