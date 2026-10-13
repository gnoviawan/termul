/**
 * #903 acceptance: two projects in one folder group each have their own pane
 * tree (parked while the other is visible). Switching p1 -> p2 -> p1 must show each project exactly its own chat tabs and
 * must never write one project's chats into the other's workspace record. Real
 * workspace / lifetime / acp / project stores; only the transports are faked
 * (in-memory persistence map, no editor/explorer I/O).
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { persisted, writes } = vi.hoisted(() => ({
  persisted: new Map<string, unknown>(),
  writes: [] as Array<{ key: string; data: unknown }>
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: {
      read: vi.fn(async (key: string) =>
        persisted.has(key)
          ? { success: true, data: structuredClone(persisted.get(key)) }
          : { success: false }
      ),
      writeDebounced: vi.fn((key: string, data: unknown) => {
        const copy = structuredClone(data)
        persisted.set(key, copy)
        writes.push({ key, data: copy })
        return Promise.resolve({ success: true })
      })
    }
  }
})

const { loadSessionIndexMock } = vi.hoisted(() => ({ loadSessionIndexMock: vi.fn() }))
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return { ...actual, loadSessionIndex: loadSessionIndexMock }
})

vi.mock('./useTerminalAutoSave', () => ({
  loadPersistedTerminals: vi.fn(async () => null)
}))

vi.mock('@/stores/editor-store', () => {
  const state = {
    openFiles: new Map(),
    activeFilePath: null,
    clearAllFiles: vi.fn(),
    openFile: vi.fn(async () => {}),
    setActiveFilePath: vi.fn()
  }
  return {
    useEditorStore: {
      getState: () => state,
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn())
    }
  }
})

vi.mock('@/stores/file-explorer-store', () => {
  const state = {
    expandedDirs: new Set<string>(),
    setExpandedDirs: vi.fn(),
    restoreExpandedDirs: vi.fn(async () => {})
  }
  return { useFileExplorerStore: { getState: () => state, subscribe: vi.fn(() => vi.fn()) } }
})

import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import {
  getAgentChatSessionIdsInAllTrees,
  getAllLeafPanes,
  useWorkspaceStore
} from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { useEditorPersistence } from './use-editor-persistence'

const P1_CHATS = ['s1', 's2', 's3']

function project(id: string): Project {
  return { id, name: id, color: 'blue', path: `/work/${id}` } as Project
}

function indexEntry(id: string, projectId: string): Record<string, unknown> {
  return {
    id,
    agentId: 'agent-1',
    title: id,
    cwd: `/work/${projectId}`,
    projectId,
    createdAt: 1,
    lastActivityAt: 2,
    messageCount: 1,
    status: 'closed'
  }
}

function treeChatIds(): string[] {
  return getAllLeafPanes(useWorkspaceStore.getState().root)
    .flatMap((leaf) => leaf.tabs)
    .flatMap((tab) => (tab.type === 'agent-chat' ? [tab.sessionId] : []))
    .sort()
}

function writtenChatIds(key: string): string[] {
  const ids: string[] = []
  for (const write of writes.filter((w) => w.key === key)) {
    const stack = [(write.data as { paneLayout?: unknown }).paneLayout]
    while (stack.length > 0) {
      const node = stack.pop() as
        | {
            type?: string
            tabs?: Array<{ type: string; sessionId?: string }>
            children?: unknown[]
          }
        | undefined
      if (!node) continue
      for (const tab of node.tabs ?? []) {
        if (tab.type === 'agent-chat' && tab.sessionId) ids.push(tab.sessionId)
      }
      stack.push(...((node.children ?? []) as typeof stack))
    }
  }
  return ids
}

function selectProject(id: string): void {
  useProjectStore.setState({ activeProjectId: id })
}

describe('#903 folder-group chat tab isolation', () => {
  beforeEach(() => {
    persisted.clear()
    writes.length = 0
    loadSessionIndexMock.mockReset()
    useAcpStore.setState(FRESH)
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {}
    })
    useWorkspaceStore.getState().resetLayout()
    useWorkspaceStore.setState({ activeProjectId: '', parkedTrees: {} })
    useProjectStore.setState({ projects: [project('p1'), project('p2')], activeProjectId: 'p1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  async function restored(projectId: string): Promise<void> {
    await waitFor(() => expect(useWorkspaceStore.getState().activeProjectId).toBe(projectId))
  }

  async function switchTo(
    hook: { rerender: (props: { id: string }) => void },
    id: string
  ): Promise<void> {
    selectProject(id)
    act(() => hook.rerender({ id }))
    await restored(id)
  }

  it('shows each project exactly its own chats across p1 -> p2 -> p1 and never cross-writes', async () => {
    useAcpStore.setState({
      sessionIndex: [...P1_CHATS.map((id) => indexEntry(id, 'p1')), indexEntry('s4', 'p2')] as never
    })
    const hook = renderHook(({ id }) => useEditorPersistence(id), { initialProps: { id: 'p1' } })
    await restored('p1')
    for (const id of P1_CHATS) useWorkspaceStore.getState().addAgentChatTab(id)
    expect(treeChatIds()).toEqual(P1_CHATS)

    await switchTo(hook, 'p2')
    expect(treeChatIds()).toEqual([])

    await switchTo(hook, 'p1')
    expect(treeChatIds()).toEqual(P1_CHATS)

    // Let any debounced persist fire, then check nothing leaked across.
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(writtenChatIds('workspace/p2')).toEqual([])
    expect(writtenChatIds('workspace/p1').sort()).toEqual(expect.arrayContaining(P1_CHATS))
    hook.unmount()
  })

  it('an index load prunes corpse chat tabs of a parked project and nothing else', async () => {
    const hook = renderHook(({ id }) => useEditorPersistence(id), { initialProps: { id: 'p1' } })
    await restored('p1')
    for (const id of ['s1', 's-corpse']) useWorkspaceStore.getState().addAgentChatTab(id)
    await switchTo(hook, 'p2')
    useWorkspaceStore.getState().addAgentChatTab('s4')

    // s1 belongs to p1, s4 to p2; neither is judged by owner. Only s-corpse is unknown.
    loadSessionIndexMock.mockResolvedValueOnce([indexEntry('s1', 'p1'), indexEntry('s4', 'p2')])
    await act(async () => {
      await useAcpStore.getState().loadSessionIndex()
    })
    expect(treeChatIds()).toEqual(['s4'])
    const parked = useWorkspaceStore.getState().parkedTrees.p1
    expect([...getAgentChatSessionIdsInAllTrees({ root: parked.root, parkedTrees: {} })]).toEqual([
      's1'
    ])
    hook.unmount()
  })
})
