import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { useMobileTabActions } from './use-mobile-tab-actions'

const { workspaceRef, mockRemoveBrowserTab, mockCloseCanvas, mockRequestCloseAgentChat } =
  vi.hoisted(() => ({
    workspaceRef: {
      current: {
        leaves: [] as Array<{ type: 'leaf'; id: string; tabs: unknown[]; activeTabId: null }>,
        activePaneId: 'pane-1',
        fullscreenPaneId: null as string | null,
        removeTab: vi.fn(),
        setActiveTab: vi.fn(),
        clearFullscreenPane: vi.fn()
      }
    },
    mockRemoveBrowserTab: vi.fn(),
    mockCloseCanvas: vi.fn(),
    mockRequestCloseAgentChat: vi.fn()
  }))

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ root: { leaves: workspaceRef.current.leaves } })),
    { getState: () => workspaceRef.current }
  )
}))
vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: { getState: () => ({ removeTab: mockRemoveBrowserTab }) }
}))
vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: { getState: () => ({ closeCanvas: mockCloseCanvas }) }
}))
vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <MemoryRouter>{children}</MemoryRouter>
)

function actions(options: Parameters<typeof useMobileTabActions>[0] = {}) {
  return renderHook(() => useMobileTabActions(options), { wrapper }).result.current
}

beforeEach(() => {
  workspaceRef.current.removeTab.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockCloseCanvas.mockReset().mockResolvedValue(undefined)
  mockRequestCloseAgentChat
    .mockReset()
    .mockImplementation((_id: string, closeTab: () => void) => closeTab())
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

  it('tears down a browser session tab, then removes the tab', () => {
    actions().closePaneTab({ type: 'browser', id: 'browser-b1', browserTabId: 'b1' })

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('browser-b1')
  })

  it('evicts a canvas before removing its tab', () => {
    actions().closePaneTab({
      type: 'canvas',
      id: 'canvas-p1',
      projectId: 'p1',
      docPath: '/p/Plan.op'
    } as WorkspaceTab)

    expect(mockCloseCanvas).toHaveBeenCalledWith('p1')
    expect(mockCloseCanvas.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceRef.current.removeTab.mock.invocationCallOrder[0]
    )
  })

  it('closes a chat through requestCloseAgentChat, removing the tab only when it completes', () => {
    const tab = { type: 'agent-chat', id: 'tab-1', sessionId: 's1' } as WorkspaceTab
    actions().closePaneTab(tab)
    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')

    workspaceRef.current.removeTab.mockReset()
    mockRequestCloseAgentChat.mockImplementation(() => {})
    actions().closePaneTab(tab)
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'git', id: 'git-/p', cwd: '/p' },
    { type: 'git-history', id: 'gh-/p', cwd: '/p' }
  ] as WorkspaceTab[])('removes a $type tab directly', (tab) => {
    expect(actions().closePaneTab(tab)).toBe(false)
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith(tab.id)
    expect(mockRemoveBrowserTab).not.toHaveBeenCalled()
    expect(mockCloseCanvas).not.toHaveBeenCalled()
  })
})
