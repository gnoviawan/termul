import { describe, expect, it } from 'vitest'
import {
  AGENT_IDLE_SHUTDOWN_MS,
  agentChatCloseAction,
  closingTurnStillRunning,
  disappearedChatIsStillOpen,
  isAgentBusy,
  openChatCountForAgent,
  selectAgentsPastIdle,
  shouldStopPreparedAgentOnProjectLeave,
  shutdownAfterLastChatTabClose
} from './agent-idle-shutdown'

const idleSession = {
  id: 's1',
  agentId: 'agent-1',
  activeTurn: false,
  openTurnId: null
}

function busyInput(overrides: Partial<Parameters<typeof isAgentBusy>[0]> = {}) {
  return {
    agentId: 'agent-1',
    agentStatus: 'connected',
    sessions: [idleSession],
    pendingPermissionAgentIds: [],
    pendingQuestionAgentIds: [],
    pendingBrowserAuthAgentIds: [],
    launchingSessionIds: new Set<string>(),
    ...overrides
  }
}

describe('isAgentBusy', () => {
  it('is false for a connected agent with an idle session', () => {
    expect(isAgentBusy(busyInput())).toBe(false)
  })

  it('is true while the process is spawning or a turn is open', () => {
    expect(isAgentBusy(busyInput({ agentStatus: 'spawning' }))).toBe(true)
    expect(
      isAgentBusy(
        busyInput({
          sessions: [{ ...idleSession, activeTurn: true }]
        })
      )
    ).toBe(true)
    expect(
      isAgentBusy(
        busyInput({
          sessions: [{ ...idleSession, openTurnId: 'turn-1' }]
        })
      )
    ).toBe(true)
    expect(
      isAgentBusy(
        busyInput({
          sessions: [{ ...idleSession, replaying: 'streaming' }]
        })
      )
    ).toBe(true)
  })

  it('is true while the user still owes the agent a permission, question, or browser sign-in', () => {
    expect(isAgentBusy(busyInput({ pendingPermissionAgentIds: ['agent-1'] }))).toBe(true)
    expect(isAgentBusy(busyInput({ pendingQuestionAgentIds: ['agent-1'] }))).toBe(true)
    expect(isAgentBusy(busyInput({ pendingBrowserAuthAgentIds: ['agent-1'] }))).toBe(true)
    expect(isAgentBusy(busyInput({ launchingSessionIds: new Set(['s1']) }))).toBe(true)
  })

  it('is true while a prompt is queued or the chat is still being prepared', () => {
    expect(isAgentBusy(busyInput({ queuedPromptSessionIds: new Set(['s1']) }))).toBe(true)
    expect(isAgentBusy(busyInput({ preparing: true }))).toBe(true)
  })

  it('ignores another agent’s turn', () => {
    expect(
      isAgentBusy(
        busyInput({
          sessions: [{ ...idleSession, agentId: 'agent-2', activeTurn: true }]
        })
      )
    ).toBe(false)
  })
})

describe('selectAgentsPastIdle', () => {
  const now = 1_000_000

  it('selects a connected idle agent after 30 minutes', () => {
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-1',
            status: 'connected',
            busy: false,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS
          }
        ],
        now
      )
    ).toEqual(['agent-1'])
  })

  it('keeps an agent that was busy inside the window', () => {
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-1',
            status: 'connected',
            busy: false,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS + 1
          }
        ],
        now
      )
    ).toEqual([])
  })

  it('keeps an idle agent while its chat tab is still open', () => {
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-1',
            status: 'connected',
            busy: false,
            openChatTabs: 1,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          }
        ],
        now
      )
    ).toEqual([])
  })

  it('keeps a busy agent and a non-connected agent', () => {
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'busy',
            status: 'connected',
            busy: true,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          },
          {
            id: 'dead',
            status: 'error',
            busy: false,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          }
        ],
        now
      )
    ).toEqual([])
  })
})

describe('shouldStopPreparedAgentOnProjectLeave', () => {
  const idleEphemeral = {
    status: 'active',
    ephemeral: true,
    activeTurn: false,
    openTurnId: null,
    launching: false,
    queuedPrompt: false
  }

  it('stops a process that only has the entrance warm-up', () => {
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 0,
        pendingPermission: false,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: [idleEphemeral]
      })
    ).toBe(true)
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 0,
        pendingPermission: false,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: []
      })
    ).toBe(true)
  })

  it('keeps a process that has a real chat, an open tab, or work in flight', () => {
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 1,
        pendingPermission: false,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: []
      })
    ).toBe(false)
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 0,
        pendingPermission: false,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: [{ ...idleEphemeral, ephemeral: false }]
      })
    ).toBe(false)
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 0,
        pendingPermission: true,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: [idleEphemeral]
      })
    ).toBe(false)
    expect(
      shouldStopPreparedAgentOnProjectLeave({
        openChatTabs: 0,
        pendingPermission: false,
        pendingQuestion: false,
        pendingBrowserAuth: false,
        sessions: [{ ...idleEphemeral, activeTurn: true }]
      })
    ).toBe(false)
  })
})

describe('shutdownAfterLastChatTabClose', () => {
  it('kills a connected idle process when no chat tab remains', () => {
    expect(
      shutdownAfterLastChatTabClose({
        status: 'connected',
        busy: false,
        remainingOpenChatTabs: 0
      })
    ).toBe('kill')
  })

  it('waits for a running turn, then keeps the process while another tab is open', () => {
    expect(
      shutdownAfterLastChatTabClose({
        status: 'connected',
        busy: true,
        remainingOpenChatTabs: 0
      })
    ).toBe('reap-when-idle')
    expect(
      shutdownAfterLastChatTabClose({
        status: 'connected',
        busy: false,
        remainingOpenChatTabs: 1
      })
    ).toBe('keep')
  })

  it('does not kill a process that is already gone', () => {
    expect(
      shutdownAfterLastChatTabClose({
        status: 'error',
        busy: false,
        remainingOpenChatTabs: 0
      })
    ).toBe('keep')
  })
})

describe('agent chat close and project switch', () => {
  it('keeps a busy chat in Closing and closes an idle chat now', () => {
    expect(agentChatCloseAction(true)).toBe('closing')
    expect(agentChatCloseAction(false)).toBe('close-now')
  })

  it('stops Closing when the turn is over even if a prompt is still queued', () => {
    expect(closingTurnStillRunning(busyInput({ queuedPromptSessionIds: new Set(['s1']) }))).toBe(
      false
    )
    expect(
      closingTurnStillRunning(busyInput({ sessions: [{ ...idleSession, activeTurn: true }] }))
    ).toBe(true)
  })

  it('treats a retained chat as still open after it leaves the visible workspace', () => {
    expect(disappearedChatIsStillOpen('s1', new Set(['s1']))).toBe(true)
    expect(disappearedChatIsStillOpen('s1', new Set())).toBe(false)
  })

  it('counts one Agent process once when the chat is both visible and retained', () => {
    const chat = { sessionId: 's1', agentId: 'agent-1' }
    expect(openChatCountForAgent({ agentId: 'agent-1', chats: [chat, chat] })).toBe(1)
    expect(
      openChatCountForAgent({
        agentId: 'agent-1',
        chats: [{ sessionId: 's1', agentId: 'agent-1' }]
      })
    ).toBe(1)
    expect(openChatCountForAgent({ agentId: 'agent-1', chats: [] })).toBe(0)
  })
})
