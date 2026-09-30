import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useVisibleSnapshot } from './use-visible-snapshot'

function Probe({ isVisible, value }: { isVisible: boolean; value: string }) {
  return <output data-testid="snap">{useVisibleSnapshot(isVisible, value)}</output>
}

describe('useVisibleSnapshot', () => {
  it('returns the live value while visible', () => {
    render(<Probe isVisible={true} value="live-a" />)

    expect(screen.getByTestId('snap').textContent).toBe('live-a')
  })

  it('freezes on the last visible value while hidden — including across an owner remap', () => {
    const { rerender } = render(<Probe isVisible={true} value="session-a" />)

    // Hide: snapshot keeps returning the last committed visible value even as
    // the live value (owner) changes underneath — the remap-while-hidden case.
    rerender(<Probe isVisible={false} value="session-a" />)
    rerender(<Probe isVisible={false} value="session-b" />)
    expect(screen.getByTestId('snap').textContent).toBe('session-a')
    rerender(<Probe isVisible={false} value="session-c" />)
    expect(screen.getByTestId('snap').textContent).toBe('session-a')

    // First visible render returns the live value — no stale-frame replay.
    rerender(<Probe isVisible={true} value="session-c" />)
    expect(screen.getByTestId('snap').textContent).toBe('session-c')
  })
})
