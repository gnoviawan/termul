import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { unpinSessionPayloadMock, pinnedIds } = vi.hoisted(() => ({
  unpinSessionPayloadMock: vi.fn(),
  pinnedIds: [] as string[]
}))
vi.mock('./acp-history-persistence', async (orig) => ({
  ...(await orig<typeof import('./acp-history-persistence')>()),
  unpinSessionPayload: unpinSessionPayloadMock,
  getPinnedSessionPayloadIds: () => [...pinnedIds]
}))

import { useAcpStore } from '@/stores/acp-store'
import { FRESH, seedSession } from '@/stores/acp-store/testkit'
import { buildProjectWorkspace, useWorkspaceStore } from '@/stores/workspace-store'
import { CHAT_PANEL_DETACH_DEBOUNCE_MS, startChatPanelDetach } from './chat-panel-detach'

function treeWith(paneId: string, sessionIds: string[]) {
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

/** Let the double requestAnimationFrame and the debounce timer elapse. */
async function afterPaintAndDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(100)
  await vi.advanceTimersByTimeAsync(CHAT_PANEL_DETACH_DEBOUNCE_MS + 50)
}

describe('startChatPanelDetach', () => {
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    unpinSessionPayloadMock.mockClear()
    pinnedIds.length = 0
    useAcpStore.setState(FRESH)
    useWorkspaceStore.setState({ activeProjectId: '', parkedTrees: {} })
    useWorkspaceStore.getState().activateProject('p1', treeWith('pane-1', ['s1']))
    stop = startChatPanelDetach()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('detaches a session that left every tree once the debounce after paint has run', async () => {
    useWorkspaceStore.getState().removeTab('chat-s1')
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_DETACH_DEBOUNCE_MS - 50)
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).toHaveBeenCalledTimes(1)
    expect(unpinSessionPayloadMock).toHaveBeenCalledWith('s1')
  })

  it('releases a pin that was taken before the watcher started and is in no tab', async () => {
    stop()
    pinnedIds.push('orphan', 's1')
    stop = startChatPanelDetach()
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).toHaveBeenCalledTimes(1)
    expect(unpinSessionPayloadMock).toHaveBeenCalledWith('orphan')
  })

  it('does not detach a session that is back in a tab before the debounce fires', async () => {
    useWorkspaceStore.getState().removeTab('chat-s1')
    await vi.advanceTimersByTimeAsync(20)
    useWorkspaceStore.getState().addAgentChatTab('s1')
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
  })

  it('does not detach a session whose tab only moved with its project into a parked tree', async () => {
    useWorkspaceStore.getState().activateProject('p2')
    await afterPaintAndDebounce()
    expect(useWorkspaceStore.getState().parkedTrees.p1).toBeDefined()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
  })

  it('detaches a session closed in a parked tree', async () => {
    useWorkspaceStore.getState().activateProject('p2')
    useWorkspaceStore.getState().removeTab('chat-s1')
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).toHaveBeenCalledWith('s1')
  })

  it('keeps a session with an active turn pinned until it goes idle, then detaches it', async () => {
    seedSession('s1', 'agent-1', true)
    useWorkspaceStore.getState().removeTab('chat-s1')
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()

    const session = useAcpStore.getState().sessions.s1
    useAcpStore.setState({
      sessions: { s1: { ...session, activeTurn: false, openTurnId: null } }
    })
    expect(unpinSessionPayloadMock).toHaveBeenCalledTimes(1)
    expect(unpinSessionPayloadMock).toHaveBeenCalledWith('s1')
  })

  it('never detaches an idle-again session that re-entered a tab while it was busy', async () => {
    seedSession('s1', 'agent-1', true)
    useWorkspaceStore.getState().removeTab('chat-s1')
    await afterPaintAndDebounce()
    useWorkspaceStore.getState().addAgentChatTab('s1')

    const session = useAcpStore.getState().sessions.s1
    useAcpStore.setState({
      sessions: { s1: { ...session, activeTurn: false, openTurnId: null } }
    })
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
  })

  it('keeps a session with a queued prompt pinned', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState({
      promptQueues: { s1: [{ id: 'q1', blocks: [], createdAt: 1 }] }
    })
    useWorkspaceStore.getState().removeTab('chat-s1')
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
  })

  it('cancels a pending detach when stopped', async () => {
    useWorkspaceStore.getState().removeTab('chat-s1')
    stop()
    await afterPaintAndDebounce()
    expect(unpinSessionPayloadMock).not.toHaveBeenCalled()
    stop = startChatPanelDetach()
  })
})
