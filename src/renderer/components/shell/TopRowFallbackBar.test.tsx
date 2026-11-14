import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopRowPlatform, TopRowRoles } from '@/lib/top-row'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { TopRowFallbackBar } from './TopRowFallbackBar'
import { TopRowProvider } from './top-row-context'

vi.mock('@/lib/api', () => ({
  windowApi: {
    onMaximizeChange: () => () => {},
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn()
  }
}))

const fallbackRoles: TopRowRoles = {
  topEdgeLeafIds: new Set(),
  rightmostLeafId: null,
  leftmostLeafId: null,
  controlsOwner: 'fallback-bar',
  showPanelOwner: 'fallback-bar'
}
const desktop: TopRowPlatform = { dragRegions: true, windowControls: true, trafficLights: false }

function renderBar(roles: TopRowRoles | null = fallbackRoles, railToggleInMain = true) {
  const bar = <TopRowFallbackBar />
  return render(
    roles ? (
      <TopRowProvider roles={roles} platform={desktop} railToggleInMain={railToggleInMain}>
        {bar}
      </TopRowProvider>
    ) : (
      bar
    )
  )
}

beforeEach(() => {
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'unavailable', sidePanelVisible: false })
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'One', path: '/repo' }] as never,
    activeProjectId: 'p1'
  })
})

describe('TopRowFallbackBar', () => {
  it('is a 44px bar on the background surface with a 0.5px bottom hairline', () => {
    renderBar()
    expect(screen.getByTestId('top-row-fallback-bar')).toHaveClass(
      'h-11',
      'bg-background',
      'border-b-[0.5px]',
      'border-border'
    )
  })

  it('starts with the expand-Rail toggle while the Rail is collapsed', () => {
    renderBar()
    const bar = screen.getByTestId('top-row-fallback-bar')
    const slot = screen.getByTestId('top-row-start-slot')
    expect(bar.firstElementChild).toBe(slot)
    expect(
      within(slot).getByRole('button', { name: 'Expand or collapse projects' })
    ).toBeInTheDocument()
    // The Side panel opens from the tool strip, never from the top row.
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })

  it('has no start slot with the Rail expanded', () => {
    renderBar(fallbackRoles, false)
    expect(screen.queryByTestId('top-row-start-slot')).toBeNull()
  })

  it('has no start slot when another surface owns it, or without a provider', () => {
    const { unmount } = renderBar({ ...fallbackRoles, showPanelOwner: 'pane' })
    expect(screen.queryByTestId('top-row-start-slot')).toBeNull()
    unmount()

    renderBar(null)
    expect(screen.queryByTestId('top-row-start-slot')).toBeNull()
  })
})
