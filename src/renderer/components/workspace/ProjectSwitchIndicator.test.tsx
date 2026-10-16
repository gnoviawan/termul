import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectSwitchStatus } from '@/lib/project-switch/status-store'
import { ProjectSwitchIndicator, SWITCH_INDICATOR_DELAY_MS } from './ProjectSwitchIndicator'

describe('ProjectSwitchIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useProjectSwitchStatus.setState({ pending: null, failed: null })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing for a switch that lands before the delay', () => {
    render(<ProjectSwitchIndicator />)
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'pending', projectId: 'b' }))
    act(() => {
      vi.advanceTimersByTime(SWITCH_INDICATOR_DELAY_MS - 10)
    })
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'idle' }))
    act(() => {
      vi.advanceTimersByTime(SWITCH_INDICATOR_DELAY_MS * 2)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows while a slow switch is pending and hides when it settles', () => {
    render(<ProjectSwitchIndicator />)
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'pending', projectId: 'b' }))
    act(() => {
      vi.advanceTimersByTime(SWITCH_INDICATOR_DELAY_MS + 10)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Switching project')
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'idle' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('restarts the delay when a newer pick replaces the pending one', () => {
    render(<ProjectSwitchIndicator />)
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'pending', projectId: 'b' }))
    act(() => {
      vi.advanceTimersByTime(SWITCH_INDICATOR_DELAY_MS + 10)
    })
    expect(screen.getByRole('status')).toBeTruthy()
    act(() => useProjectSwitchStatus.getState().apply({ kind: 'pending', projectId: 'c' }))
    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(SWITCH_INDICATOR_DELAY_MS + 10)
    })
    expect(screen.getByRole('status')).toBeTruthy()
  })
})
