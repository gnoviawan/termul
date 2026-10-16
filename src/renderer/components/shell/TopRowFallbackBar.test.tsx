import { render, screen } from '@testing-library/react'
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

function renderBar(roles: TopRowRoles | null = fallbackRoles) {
  const bar = <TopRowFallbackBar />
  return render(
    roles ? (
      <TopRowProvider roles={roles} platform={desktop}>
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
  it('starts with the Show side panel button while the Side panel is hidden', () => {
    renderBar()
    const bar = screen.getByTestId('top-row-fallback-bar')
    const slot = screen.getByTestId('show-side-panel-slot')
    expect(bar.firstElementChild).toBe(slot)
    expect(screen.getByRole('button', { name: 'Show side panel' })).toBeInTheDocument()
  })

  it('has no button while the Side panel is visible', () => {
    useShellLayoutStore.setState({ sidePanelVisible: true })
    renderBar()
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })

  it('has no button when the project has no folder to show', () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'One' }] as never })
    renderBar()
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })

  it('has no button when another surface owns it, or without a provider', () => {
    const { unmount } = renderBar({ ...fallbackRoles, showPanelOwner: 'pane' })
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
    unmount()

    renderBar(null)
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })
})
