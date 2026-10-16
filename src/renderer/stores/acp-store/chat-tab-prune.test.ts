import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildProjectWorkspace,
  createProjectWorkspace,
  getAgentChatSessionIdsInAllTrees,
  getAllLeafPanes,
  useWorkspaceStore
} from '@/stores/workspace-store'
import { pruneRestoredChatTabs } from './chat-tab-prune'

function chatLeaf(paneId: string, sessionIds: string[]) {
  return buildProjectWorkspace({
    type: 'leaf',
    id: paneId,
    activeTabId: sessionIds[0] ? `chat-${sessionIds[0]}` : null,
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-chat' as const,
      id: `chat-${sessionId}`,
      sessionId
    }))
  })
}

function prune(indexed: string[], live: string[] = []): void {
  pruneRestoredChatTabs({ liveSessionIds: new Set(live), indexedSessionIds: new Set(indexed) })
}

function activeSessionIds(): string[] {
  return getAllLeafPanes(useWorkspaceStore.getState().root).flatMap((leaf) =>
    leaf.tabs.flatMap((tab) => (tab.type === 'agent-chat' ? [tab.sessionId] : []))
  )
}

describe('pruneRestoredChatTabs', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeProjectId: '',
      parkedTrees: {},
      ...createProjectWorkspace()
    })
  })

  it('removes a corpse tab that is neither live nor indexed', () => {
    useWorkspaceStore.getState().activateProject('p1', chatLeaf('pane-1', ['s-corpse', 's-own']))
    prune(['s-own'])
    expect(activeSessionIds()).toEqual(['s-own'])
  })

  it('keeps a live session that the index does not know yet', () => {
    useWorkspaceStore.getState().activateProject('p1', chatLeaf('pane-1', ['s-live']))
    prune([], ['s-live'])
    expect(activeSessionIds()).toEqual(['s-live'])
  })

  it('removes corpse tabs from parked trees too and leaves their other chats', () => {
    const workspace = useWorkspaceStore.getState()
    workspace.activateProject('p1', chatLeaf('pane-1', ['s-corpse-1', 's-kept-1']))
    workspace.activateProject('p2', chatLeaf('pane-2', ['s-kept-2', 's-corpse-2']))
    prune(['s-kept-1', 's-kept-2'])
    expect([...getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())].sort()).toEqual([
      's-kept-1',
      's-kept-2'
    ])
    expect(useWorkspaceStore.getState().parkedTrees.p1).toBeDefined()
  })

  it("never judges ownership: another project's indexed chat stays where it is", () => {
    useWorkspaceStore.getState().activateProject('p1', chatLeaf('pane-1', ['s-other-project']))
    prune(['s-other-project'])
    expect(activeSessionIds()).toEqual(['s-other-project'])
  })
})
