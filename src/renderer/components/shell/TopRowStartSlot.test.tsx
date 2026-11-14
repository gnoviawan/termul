import { render, renderHook, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { selectTopRowRoles, type TopRowPlatform } from '@/lib/top-row'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { TopRowStartSlot, useTopRowStartSlotVisible } from './TopRowStartSlot'
import { TopRowProvider } from './top-row-context'

const roles = selectTopRowRoles({
  root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
  fullscreenPaneId: null,
  mode: 'panes'
})
const platform: TopRowPlatform = { dragRegions: true, windowControls: false, trafficLights: true }

function wrapper(mainStartInsetPx: number, railToggleInMain: boolean) {
  return ({ children }: { children: React.ReactNode }) => (
    <TopRowProvider
      roles={roles}
      platform={platform}
      mainStartInsetPx={mainStartInsetPx}
      railToggleInMain={railToggleInMain}
    >
      {children}
    </TopRowProvider>
  )
}

beforeEach(() => {
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'unavailable', railExpanded: false })
})

describe('TopRowStartSlot', () => {
  it('pads 24px past the traffic lights, then the expand toggle (x = 72, Paper 2.3)', () => {
    render(<TopRowStartSlot />, { wrapper: wrapper(24, true) })
    const slot = screen.getByTestId('top-row-start-slot')
    expect(slot).toHaveStyle({ paddingLeft: '24px' })
    expect(
      within(slot).getByRole('button', { name: 'Expand or collapse projects' })
    ).toBeInTheDocument()
    // The Side panel opens from the tool strip, never from here.
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })

  it('uses the 6px bar padding without the traffic lights', () => {
    render(<TopRowStartSlot />, { wrapper: wrapper(0, true) })
    const slot = screen.getByTestId('top-row-start-slot')
    expect(slot).toHaveClass('pl-1.5')
    expect(slot.style.paddingLeft).toBe('')
  })

  it('renders nothing with the Rail expanded and no inset, or without a provider', () => {
    const { unmount } = render(<TopRowStartSlot />, { wrapper: wrapper(0, false) })
    expect(screen.queryByTestId('top-row-start-slot')).toBeNull()
    unmount()
    render(<TopRowStartSlot />)
    expect(screen.queryByTestId('top-row-start-slot')).toBeNull()
  })

  it('reports its visibility', () => {
    expect(
      renderHook(() => useTopRowStartSlotVisible(), { wrapper: wrapper(0, false) }).result.current
    ).toBe(false)
    expect(
      renderHook(() => useTopRowStartSlotVisible(), { wrapper: wrapper(0, true) }).result.current
    ).toBe(true)
    expect(
      renderHook(() => useTopRowStartSlotVisible(), { wrapper: wrapper(24, false) }).result.current
    ).toBe(true)
  })
})
