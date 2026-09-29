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

// --- Story 6 (spec-in-chat-agent-switch): idle reap vs the detached old agent

describe('idle reap vs a detached old agent (switch teardown)', () => {
  const now = 1_000_000
  // A switched chat after the remap: the tab now cites the NEW session, whose
  // record's agentId is the NEW agent — the OLD (detached) agent's process
  // counts zero open tabs from that chat. The detach-only contract (kill
  // stays the reaper's decision) keeps the OLD agent resolvable while it is
  // still busy or owns another chat tab.
  const switchedChats = [
    { sessionId: 's-old', agentId: 'agent-new' },
    { sessionId: 's-new', agentId: 'agent-new' }
  ]

  it('does not reap a DETACHED old agent whose old-session chat still has an open tab', () => {
    // The old session's chat tab is still open (e.g. a second pane shows the
    // pre-switch transcript): openChatCountForAgent resolves the old agent
    // from that tab's session record, and the idle selector keeps it.
    const chats = [...switchedChats, { sessionId: 's-old-kept', agentId: 'agent-old' }]
    const openTabs = openChatCountForAgent({ agentId: 'agent-old', chats })
    expect(openTabs).toBe(1)
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-old',
            status: 'connected',
            busy: false,
            openChatTabs: openTabs,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          }
        ],
        now
      )
    ).toEqual([])
  })

  it('does not reap a DETACHED old agent that is still busy (in-flight turn on the old session)', () => {
    // The old agent kept a live turn (the detached key keeps the process
    // resolvable for its open sessions) — busy wins over the idle clock.
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-old',
            status: 'connected',
            busy: true,
            openChatTabs: 0,
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          }
        ],
        now
      )
    ).toEqual([])
    // The busy predicate behind it: an old-session turn keeps the old agent busy.
    expect(
      isAgentBusy(
        busyInput({
          agentId: 'agent-old',
          sessions: [{ ...idleSession, id: 's-old', agentId: 'agent-old', activeTurn: true }]
        })
      )
    ).toBe(true)
  })

  it('reaps the detached old agent once idle AND tab-free (the switch teardown contract)', () => {
    // The eventual teardown: no open tab, not busy, past the window → the
    // reaper may kill the detached process (this is what "kill stays the
    // idle reaper's decision" means — detach does not keep it alive forever).
    expect(
      selectAgentsPastIdle(
        [
          {
            id: 'agent-old',
            status: 'connected',
            busy: false,
            openChatTabs: openChatCountForAgent({
              agentId: 'agent-old',
              chats: switchedChats
            }),
            lastBusyAt: now - AGENT_IDLE_SHUTDOWN_MS - 1
          }
        ],
        now
      )
    ).toEqual(['agent-old'])
  })

  it('shutdownAfterLastChatTabClose keeps the old agent while the remapped tab still counts for the NEW agent only', () => {
    // After the remap, the last visible tab for the OLD agent closes: the
    // decision input's remainingOpenChatTabs comes from openChatCountForAgent
    // — which counts only the NEW agent's chats — so an idle old agent is
    // 'kill' (the teardown path), while a busy one waits ('reap-when-idle').
    const remaining = openChatCountForAgent({ agentId: 'agent-old', chats: switchedChats })
    expect(remaining).toBe(0)
    expect(
      shutdownAfterLastChatTabClose({
        status: 'connected',
        busy: false,
        remainingOpenChatTabs: remaining
      })
    ).toBe('kill')
    expect(
      shutdownAfterLastChatTabClose({
        status: 'connected',
        busy: true,
        remainingOpenChatTabs: remaining
      })
    ).toBe('reap-when-idle')
  })
})
