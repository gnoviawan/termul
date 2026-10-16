import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { useMobileTabActions } from './use-mobile-tab-actions'

const { workspaceRef } = vi.hoisted(() => ({
  workspaceRef: {
    current: {
      leaves: [] as Array<{ type: 'leaf'; id: string; tabs: unknown[]; activeTabId: null }>,
      activePaneId: 'pane-1',
      fullscreenPaneId: null as string | null,
      removeTab: vi.fn(),
      setActiveTab: vi.fn(),
      clearFullscreenPane: vi.fn()
    }
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ root: { leaves: workspaceRef.current.leaves } })),
    { getState: () => workspaceRef.current }
  )
}))

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <MemoryRouter>{children}</MemoryRouter>
)

function actions(options: Parameters<typeof useMobileTabActions>[0] = {}) {
  return renderHook(() => useMobileTabActions(options), { wrapper }).result.current
}

beforeEach(() => {
  workspaceRef.current.removeTab.mockReset()
})

describe('useMobileTabActions closePaneTab', () => {
  it('routes an editor through the dirty guard and reports its confirm', () => {
    const onCloseEditorTab = vi.fn(() => true)
    const { closePaneTab } = actions({ onCloseEditorTab })

    expect(closePaneTab({ type: 'editor', id: 'e1', filePath: '/a.ts' })).toBe(true)
    expect(onCloseEditorTab).toHaveBeenCalledWith('/a.ts')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('falls back to removeTab for an editor with no guard threaded', () => {
    expect(actions().closePaneTab({ type: 'editor', id: 'e1', filePath: '/a.ts' })).toBe(false)
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('e1')
  })

  it('routes a terminal through its close flow and reports its confirm', () => {
    const onCloseTerminal = vi.fn(() => true)
    const tab: WorkspaceTab = { type: 'terminal', id: 'term-t1', terminalId: 't1' }

    expect(actions({ onCloseTerminal }).closePaneTab(tab)).toBe(true)
    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(actions().closePaneTab(tab)).toBe(false)
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })
})
