/**
 * spec-acp-browser-automation-v2 CAP-3: the agent browser tab "open" event
 * routes into a dedicated right ~2/3 pane via the real workspace-store
 * (openAgentBrowserTab), keeping the chat pane focused. Remote/web surfaces
 * (isTauriContext false) stay informational — the event opens nothing there.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/acp-agents-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

import { isTauriContext } from '@/lib/tauri-runtime'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import { useAcpStore } from './index'

function getLeavesFromNode(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(getLeavesFromNode)
}

beforeEach(() => {
  useWorkspaceStore.setState(() => {
    const root: LeafNode = {
      type: 'leaf',
      id: 'pane-chat',
      tabs: [{ type: 'agent-chat', id: 'chat-s1', sessionId: 's1' }],
      activeTabId: 'chat-s1'
    }
    return {
      root,
      activePaneId: 'pane-chat',
      fullscreenPaneId: null,
      agentLauncherPaneId: null,
      agentBrowserPaneId: null
    }
  })
  useBrowserSessionStore.setState({ tabs: new Map() })
})

describe('_onBrowserAgentTab open (CAP-3 dedicated agent browser pane)', () => {
  it('opens the first agent browser tab in a right 2/3 pane while the chat pane stays focused', () => {
    useAcpStore.getState()._onBrowserAgentTab({
      action: 'open',
      tabId: 'agent-tab-1',
      url: 'https://example.com',
      sessionId: 'sess-1'
    })

    const state = useWorkspaceStore.getState()
    expect(state.root.type).toBe('split')
    const split = state.root as SplitNode
    expect(split.direction).toBe('horizontal')
    expect(split.sizes[0]).toBeCloseTo(33.3)
    expect(split.sizes[1]).toBeCloseTo(66.7)
    const chatPane = split.children[0] as LeafNode
    const browserPane = split.children[1] as LeafNode
    expect(chatPane.id).toBe('pane-chat')
    expect(chatPane.activeTabId).toBe('chat-s1')
    expect(browserPane.tabs.map((t) => t.id)).toEqual(['browser-agent-tab-1'])
    expect(browserPane.activeTabId).toBe('browser-agent-tab-1')
    expect(state.activePaneId).toBe('pane-chat')

    const sessionTab = useBrowserSessionStore.getState().getTab('agent-tab-1')
    expect(sessionTab?.url).toBe('https://example.com')
    expect(sessionTab?.agentControlled).toBe(true)
  })

  it('a second session open reuses the dedicated pane with no additional split', () => {
    const store = useAcpStore.getState()
    store._onBrowserAgentTab({ action: 'open', tabId: 'agent-tab-1', sessionId: 'sess-1' })

    store._onBrowserAgentTab({
      action: 'open',
      tabId: 'agent-tab-2',
      url: 'https://example.org',
      sessionId: 'sess-2'
    })

    const state = useWorkspaceStore.getState()
    const root = state.root as SplitNode
    expect(getLeavesFromNode(root)).toHaveLength(2)
    const browserPane = root.children[1] as LeafNode
    expect(browserPane.tabs.map((t) => t.id)).toEqual([
      'browser-agent-tab-1',
      'browser-agent-tab-2'
    ])
    expect(browserPane.activeTabId).toBe('browser-agent-tab-2')
    expect(state.activePaneId).toBe('pane-chat')
  })

  it('is informational on non-Tauri surfaces: the workspace is untouched', () => {
    vi.mocked(isTauriContext).mockReturnValueOnce(false)

    useAcpStore.getState()._onBrowserAgentTab({
      action: 'open',
      tabId: 'agent-tab-1',
      url: 'https://example.com',
      sessionId: 'sess-1'
    })

    const state = useWorkspaceStore.getState()
    expect(state.root.type).toBe('leaf')
    expect(state.activePaneId).toBe('pane-chat')
    expect(useBrowserSessionStore.getState().getTab('agent-tab-1')).toBeUndefined()
  })
})
