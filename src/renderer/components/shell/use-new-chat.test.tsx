import { act, renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useNewChat } from './use-new-chat'

const showAgentLauncher = vi.fn()

function renderNewChat(path: string) {
  return renderHook(() => ({ newChat: useNewChat(), pathname: useLocation().pathname }), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  })
}

beforeEach(() => {
  showAgentLauncher.mockReset()
  useWorkspaceStore.setState({ activePaneId: 'pane-1', showAgentLauncher })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useNewChat', () => {
  it('opens the launcher in the active pane on the workspace route', () => {
    const { result } = renderNewChat('/')
    act(() => result.current.newChat())
    expect(showAgentLauncher).toHaveBeenCalledWith('pane-1')
  })

  it('goes back to the workspace route first, then opens the launcher', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const { result } = renderNewChat('/settings')
    act(() => result.current.newChat())
    expect(result.current.pathname).toBe('/')
    expect(showAgentLauncher).toHaveBeenCalledWith('pane-1')
  })

  it('does nothing without an active pane', () => {
    useWorkspaceStore.setState({ activePaneId: null } as never)
    const { result } = renderNewChat('/')
    act(() => result.current.newChat())
    expect(showAgentLauncher).not.toHaveBeenCalled()
  })
})
