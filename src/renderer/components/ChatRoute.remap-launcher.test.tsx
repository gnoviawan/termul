import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { createHashRouter, RouterProvider, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRouterNavigate } from '@/lib/router-navigate'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { ChatRoute } from './ChatRoute'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function BindNavigate(): null {
  const navigate = useNavigate()
  useEffect(() => {
    setRouterNavigate(navigate)
    return () => setRouterNavigate(null)
  }, [navigate])
  return null
}

function renderRoutes(): void {
  const router = createHashRouter([
    {
      path: '*',
      element: (
        <>
          <BindNavigate />
          <ChatRoute />
        </>
      )
    }
  ])
  render(<RouterProvider router={router} />)
}

function liveSession(id: string): Record<string, unknown> {
  return { id, status: 'ready' }
}

function setSessions(ids: string[]): void {
  useAcpStore.setState({
    sessions: Object.fromEntries(ids.map((id) => [id, liveSession(id)])) as never
  })
}

const routeHash = (): string => window.location.hash

describe('a placeholder chat remapped while the launcher is open again', () => {
  let launcherHistory: Array<string | null>
  let unsubscribe: () => void

  beforeEach(() => {
    window.location.hash = '#/'
    const root: LeafNode = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
    useWorkspaceStore.setState({
      root,
      activePaneId: 'pane-1',
      fullscreenPaneId: null,
      agentLauncherPaneId: 'pane-1'
    })
    setSessions([])
    launcherHistory = []
    unsubscribe = useWorkspaceStore.subscribe((s, prev) => {
      if (s.agentLauncherPaneId !== prev.agentLauncherPaneId) {
        launcherHistory.push(s.agentLauncherPaneId)
      }
    })
    renderRoutes()
  })

  afterEach(() => {
    unsubscribe()
  })

  it('keeps the reopened launcher open and renames the route to the real session', async () => {
    await act(async () => {
      setSessions(['launch-a'])
      useWorkspaceStore.getState().addAgentChatTab('launch-a', 'pane-1')
      useWorkspaceStore.getState().hideAgentLauncher()
    })
    expect(routeHash()).toBe('#/c/launch-a')

    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'))
      useWorkspaceStore.getState().showAgentLauncher('pane-1')
    })
    launcherHistory = []

    await act(async () => {
      setSessions(['s-a'])
      useWorkspaceStore.getState().remapAgentChatSession('launch-a', 's-a', 'pane-1')
    })

    const state = useWorkspaceStore.getState()
    expect(launcherHistory).toEqual([])
    expect(state.agentLauncherPaneId).toBe('pane-1')
    expect((state.root as LeafNode).tabs.map((t) => t.id)).toEqual(['chat-s-a'])
    expect(routeHash()).toBe('#/c/s-a')
  })

  it('leaves the route and pane focus alone when the user moved to another chat', async () => {
    await act(async () => {
      setSessions(['launch-a', 's-b'])
      useWorkspaceStore.getState().addAgentChatTab('launch-a', 'pane-1')
      useWorkspaceStore.getState().hideAgentLauncher()
    })
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'))
      useWorkspaceStore.getState().addAgentChatTab('s-b', 'pane-1')
    })
    expect(routeHash()).toBe('#/c/s-b')

    await act(async () => {
      setSessions(['s-a', 's-b'])
      useWorkspaceStore.getState().remapAgentChatSession('launch-a', 's-a', 'pane-1')
    })

    const leaf = useWorkspaceStore.getState().root as LeafNode
    expect(leaf.tabs.map((t) => t.id)).toEqual(['chat-s-a', 'chat-s-b'])
    expect(leaf.activeTabId).toBe('chat-s-b')
    expect(routeHash()).toBe('#/c/s-b')
  })
})
