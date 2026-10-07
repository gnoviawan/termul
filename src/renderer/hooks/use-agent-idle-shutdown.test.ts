/**
 * Close-flow liveness for agent chats (spec-acp-dead-turn-recovery).
 *
 * A chat whose agent is not `connected`/`spawning` can never produce the
 * `prompt_complete` the Closing state waits on, so close must be immediate
 * and a prior Closing must finish on the next `finishClosingChats` pass.
 * These tests exercise `requestCloseAgentChat` and the hook's subscription
 * against the REAL acp/lifetime/workspace stores (seeded via setState, the
 * `agent-chat-tab.test.tsx` pattern) rather than re-testing the pure helpers
 * (`agent-idle-shutdown.test.ts` covers those).
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH, seedSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { requestCloseAgentChat, useAgentIdleShutdown } from './use-agent-idle-shutdown'

vi.mock('@/lib/log-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/log-api')>()),
  logFrontendError: vi.fn()
}))

const closingIds = () => useAgentChatLifetimeStore.getState().closingSessionIds

function chatTabIsVisible(sessionId: string): boolean {
  return getAllLeafPanes(useWorkspaceStore.getState().root).some((leaf) =>
    leaf.tabs.some((tab) => tab.type === 'agent-chat' && tab.sessionId === sessionId)
  )
}

function setWorkspaceRoot(tabs: { type: 'agent-chat'; id: string; sessionId: string }[]): void {
  useWorkspaceStore.setState({
    root: { type: 'leaf', id: 'pane-1', tabs, activeTabId: tabs[0]?.id ?? null },
    activePaneId: 'pane-1',
    fullscreenPaneId: null,
    agentLauncherPaneId: null
  })
}

function seedChatTab(sessionId: string): void {
  const id = `chat-${sessionId}`
  setWorkspaceRoot([{ type: 'agent-chat', id, sessionId }])
}

describe('requestCloseAgentChat liveness gate', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {},
      closingSessionIds: {}
    })
    setWorkspaceRoot([])
  })

  // Matrix row: "Close with dead agent" — 'error'/'idle'/absent agentStatus +
  // stale activeTurn/openTurnId must close now (the dead process can never
  // emit the prompt_complete Closing would wait on).
  it.each([
    'error',
    'idle',
    undefined
  ] as const)('closes now when the agent is dead/absent (status %s) despite stale turn flags', (agentStatus) => {
    useAcpStore.setState({
      agentStatus: agentStatus === undefined ? {} : { 'agent-1': agentStatus }
    })
    seedSession('s1', 'agent-1', true)
    const closeTab = vi.fn()
    requestCloseAgentChat('s1', closeTab)
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closingIds().s1).toBeUndefined()
  })

  // Matrix row: "Live-turn close" — unchanged: a connected agent with a
  // running turn stays 'closing' until the turn ends.
  it('keeps a connected live-turn chat in Closing and finishes it when the turn ends', () => {
    useAcpStore.setState({ agentStatus: { 'agent-1': 'connected' } })
    seedSession('s1', 'agent-1', true)
    seedChatTab('s1')
    renderHook(() => useAgentIdleShutdown())

    const closeTab = vi.fn()
    act(() => requestCloseAgentChat('s1', closeTab))
    expect(closeTab).not.toHaveBeenCalled()
    expect(closingIds().s1).toBe(true)
    expect(chatTabIsVisible('s1')).toBe(true)

    // The turn completes on the still-connected agent → the subscription's
    // finishClosingChats clears Closing and removes the tab.
    act(() => {
      const session = useAcpStore.getState().sessions.s1
      useAcpStore.setState({
        sessions: { s1: { ...session, activeTurn: false, openTurnId: null } }
      })
    })
    expect(closingIds().s1).toBeUndefined()
    expect(chatTabIsVisible('s1')).toBe(false)
  })

  // Matrix row: "Closing chat, agent dies" — markClosing while connected,
  // then the agent disconnects/crashes → the next finishClosingChats pass
  // clears Closing and removes the tab instead of waiting forever.
  // Review finding: a chat still launching has `agentId: ''`, so the status
  // lookup yields undefined — without the launch exemption the liveness gate
  // discards the `launchingSessionIds` busy evidence, closes now, and
  // `remapAgentChatSession`'s add fallback later resurrects the tab the user
  // just closed (and still sends the prompt).
  it('keeps a mid-launch chat in Closing — the arriving agent can still finish work', () => {
    useAcpStore.setState({
      agentStatus: {},
      launchingSessionIds: { 's-launch': true }
    })
    seedSession('s-launch', '', false)
    const closeTab = vi.fn()
    requestCloseAgentChat('s-launch', closeTab)
    expect(closeTab).not.toHaveBeenCalled()
    expect(closingIds()['s-launch']).toBe(true)
  })

  it.each([
    'error',
    'idle'
  ] as const)('finishes a Closing chat whose agent dies mid-close (status → %s)', (deadStatus) => {
    useAcpStore.setState({ agentStatus: { 'agent-1': 'connected' } })
    seedSession('s1', 'agent-1', true)
    seedChatTab('s1')
    renderHook(() => useAgentIdleShutdown())

    const closeTab = vi.fn()
    act(() => requestCloseAgentChat('s1', closeTab))
    expect(closeTab).not.toHaveBeenCalled()
    expect(closingIds().s1).toBe(true)

    // Agent process dies while the chat sits in Closing.
    act(() => {
      useAcpStore.setState({ agentStatus: { 'agent-1': deadStatus } })
    })
    expect(closingIds().s1).toBeUndefined()
    expect(chatTabIsVisible('s1')).toBe(false)
  })
})
