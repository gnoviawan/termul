import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { closeWorkspaceTab, type GuardedTabClose } from './workspace-tab-close'

const { mockRemoveTab, mockRemoveBrowserTab, mockCloseCanvas, mockCloseAgentChat, mockLog } =
  vi.hoisted(() => ({
    mockRemoveTab: vi.fn(),
    mockRemoveBrowserTab: vi.fn(),
    mockCloseCanvas: vi.fn(),
    mockCloseAgentChat: vi.fn(),
    mockLog: vi.fn()
  }))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ removeTab: mockRemoveTab }) }
}))
vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: { getState: () => ({ removeTab: mockRemoveBrowserTab }) }
}))
vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: { getState: () => ({ closeCanvas: mockCloseCanvas }) }
}))
vi.mock('@/lib/agent-chat-close', () => ({ closeAgentChat: mockCloseAgentChat }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))

function guarded(): GuardedTabClose & {
  terminal: ReturnType<typeof vi.fn>
  editor: ReturnType<typeof vi.fn>
} {
  return { terminal: vi.fn(() => true), editor: vi.fn(() => true) }
}

function close(tab: WorkspaceTab, handlers: GuardedTabClose = guarded()): boolean {
  return closeWorkspaceTab(tab, handlers, 'test.close')
}

beforeEach(() => {
  mockRemoveTab.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockCloseCanvas.mockReset().mockResolvedValue(undefined)
  mockLog.mockReset().mockResolvedValue(undefined)
  mockCloseAgentChat
    .mockReset()
    .mockImplementation((_id: string, closeTab: () => void) => closeTab())
})

describe('closeWorkspaceTab', () => {
  it('hands a terminal to the caller and returns its confirm result', () => {
    const handlers = guarded()
    const tab: WorkspaceTab = { type: 'terminal', id: 'term-t1', terminalId: 't1' }

    expect(close(tab, handlers)).toBe(true)
    expect(handlers.terminal).toHaveBeenCalledWith(tab)
    expect(handlers.editor).not.toHaveBeenCalled()
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it('hands an editor to the caller and returns its confirm result', () => {
    const handlers = guarded()
    handlers.editor.mockReturnValue(false)
    const tab: WorkspaceTab = { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }

    expect(close(tab, handlers)).toBe(false)
    expect(handlers.editor).toHaveBeenCalledWith(tab)
    expect(handlers.terminal).not.toHaveBeenCalled()
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it('tears down a browser session tab, then removes the tab', () => {
    expect(close({ type: 'browser', id: 'browser-b1', browserTabId: 'b1' })).toBe(false)

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(mockRemoveTab).toHaveBeenCalledWith('browser-b1')
  })

  it('evicts a canvas before removing its tab', () => {
    expect(close({ type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/p/Plan.op' })).toBe(
      false
    )

    expect(mockCloseCanvas).toHaveBeenCalledWith('p1')
    expect(mockCloseCanvas.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveTab.mock.invocationCallOrder[0]
    )
  })

  it('closes a chat through closeAgentChat, removing the tab only when it completes', () => {
    const tab: WorkspaceTab = { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }
    expect(close(tab)).toBe(false)
    expect(mockCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(mockRemoveTab).toHaveBeenCalledWith('tab-1')

    mockRemoveTab.mockReset()
    mockCloseAgentChat.mockImplementation(() => {})
    close(tab)
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'git', id: 'git-/p', cwd: '/p' },
    { type: 'git-history', id: 'gh-/p', cwd: '/p' },
    { type: 'diff', id: 'diff:1', cwd: '/p', path: 'a.ts', staged: false },
    { type: 'commit-diff', id: 'diff:2', cwd: '/p', commit: 'a'.repeat(40), path: 'a.ts' }
  ] as WorkspaceTab[])('removes a $type tab directly', (tab) => {
    expect(close(tab)).toBe(false)
    expect(mockRemoveTab).toHaveBeenCalledWith(tab.id)
    expect(mockRemoveBrowserTab).not.toHaveBeenCalled()
    expect(mockCloseCanvas).not.toHaveBeenCalled()
    expect(mockCloseAgentChat).not.toHaveBeenCalled()
  })

  it('removes a tab of an unrecognised kind and warns with the caller source', () => {
    const handlers = guarded()
    const tab = { type: 'hologram', id: 'holo-1' } as unknown as WorkspaceTab

    expect(close(tab, handlers)).toBe(false)
    expect(mockRemoveTab).toHaveBeenCalledWith('holo-1')
    expect(handlers.terminal).not.toHaveBeenCalled()
    expect(handlers.editor).not.toHaveBeenCalled()
    expect(mockLog).toHaveBeenCalledWith({
      level: 'warn',
      source: 'test.close',
      message: 'Unrecognised workspace tab kind "hologram" — closed without teardown'
    })
  })
})
