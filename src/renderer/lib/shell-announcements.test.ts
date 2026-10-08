import { describe, expect, it } from 'vitest'
import {
  type AcpAnnouncementState,
  type AnnouncementContext,
  type AnnouncementSession,
  APPROVAL_NEEDED,
  CONNECTION_CONNECTED,
  CONNECTION_DISCONNECTED,
  CONNECTION_RECONNECTING,
  type ConnectionAnnouncementMemory,
  type ConnectionAnnouncementState,
  chatsMatchAnnouncement,
  DEFAULT_CHAT_LABEL,
  deriveAcpAnnouncements,
  deriveConnectionAnnouncements,
  needsYouAnnouncement,
  resolveChatLabel,
  switchFailedAnnouncement,
  switchingAnnouncement,
  TURN_FINISHED
} from './shell-announcements'

function session(overrides: Partial<AnnouncementSession> = {}): AnnouncementSession {
  return {
    agentId: 'agent-1',
    projectId: 'p1',
    status: 'active',
    activeTurn: false,
    ...overrides
  }
}

function acpState(overrides: Partial<AcpAnnouncementState> = {}): AcpAnnouncementState {
  return {
    sessions: {},
    agentStatus: { 'agent-1': 'connected' },
    pendingPermissions: {},
    pendingQuestions: {},
    pendingElicitations: {},
    switchingProjectId: null,
    failedProjectSwitchId: null,
    ...overrides
  }
}

function context(overrides: Partial<AnnouncementContext> = {}): AnnouncementContext {
  return {
    activeChatId: 'active',
    activeProjectId: 'p1',
    candidateChatIds: new Set(['active', 'other']),
    chatLabel: (id) => `Chat ${id}`,
    projectName: (id) => `Project ${id}`,
    ...overrides
  }
}

/** Two chats in project p1: `active` (the active tab) and `other`. */
function twoChats(
  overrides: { active?: Partial<AnnouncementSession>; other?: Partial<AnnouncementSession> } = {}
): AcpAnnouncementState['sessions'] {
  return {
    active: session(overrides.active),
    other: session(overrides.other)
  }
}

/** Baseline evaluation, then a second one; returns the second one's announcements. */
function transition(
  before: AcpAnnouncementState,
  after: AcpAnnouncementState,
  ctx: AnnouncementContext = context()
): string[] {
  const baseline = deriveAcpAnnouncements(null, before, ctx)
  return deriveAcpAnnouncements(baseline.memory, after, ctx).announcements
}

describe('announcement strings', () => {
  it('builds the verbatim strings', () => {
    expect(APPROVAL_NEEDED).toBe('Approval needed')
    expect(TURN_FINISHED).toBe('Turn finished')
    expect(needsYouAnnouncement('Fix auth')).toBe('Fix auth needs you')
    expect(switchingAnnouncement('pecut-web')).toBe('Switching to pecut-web…')
    expect(switchFailedAnnouncement('docs-site')).toBe("Couldn't switch to docs-site")
    expect(CONNECTION_RECONNECTING).toBe('Reconnecting…')
    expect(CONNECTION_DISCONNECTED).toBe('Disconnected')
    expect(CONNECTION_CONNECTED).toBe('Connected')
  })

  it('uses the singular only for exactly one match', () => {
    expect(chatsMatchAnnouncement(0)).toBe('0 chats match')
    expect(chatsMatchAnnouncement(1)).toBe('1 chat matches')
    expect(chatsMatchAnnouncement(2)).toBe('2 chats match')
    expect(chatsMatchAnnouncement(12)).toBe('12 chats match')
  })

  it('resolves the chat label through live title, index title, then Agent Chat', () => {
    expect(resolveChatLabel('Live', 'Index')).toBe('Live')
    expect(resolveChatLabel(null, 'Index')).toBe('Index')
    expect(resolveChatLabel('', 'Index')).toBe('Index')
    expect(resolveChatLabel(undefined, undefined)).toBe(DEFAULT_CHAT_LABEL)
    expect(resolveChatLabel(null, '')).toBe('Agent Chat')
  })
})

describe('deriveAcpAnnouncements: baseline', () => {
  it('is silent on the first observation, even with approvals and needs-you chats pending', () => {
    const state = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'active' } },
      pendingQuestions: { q1: { sessionId: 'other' } },
      switchingProjectId: 'p2',
      failedProjectSwitchId: 'p3'
    })
    const result = deriveAcpAnnouncements(null, state, context())
    expect(result.announcements).toEqual([])
    expect(result.memory.approvalKeys).toEqual(new Set(['permission:r1', 'question:q1']))
    expect(result.memory.needsYou).toEqual({ active: true, other: true })
    expect(result.memory.switchingProjectId).toBe('p2')
  })

  it('stays silent on an unchanged re-evaluation', () => {
    const state = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'active' } }
    })
    expect(transition(state, state)).toEqual([])
  })

  it('is silent when a session is first seen already needing you or holding an approval', () => {
    const before = acpState({ sessions: { active: session() } })
    const after = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'other' } }
    })
    expect(transition(before, after)).toEqual([])
  })

  it('is silent when the active session and its approval first appear together', () => {
    const before = acpState({ sessions: { other: session() } })
    const after = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'active' } }
    })
    expect(transition(before, after)).toEqual([])
  })
})

describe('deriveAcpAnnouncements: approvals in the active chat', () => {
  const idle = acpState({ sessions: twoChats() })

  it.each([
    ['permission', { pendingPermissions: { r1: { sessionId: 'active' } } }],
    ['question', { pendingQuestions: { q1: { sessionId: 'active' } } }],
    ['elicitation', { pendingElicitations: { e1: { sessionId: 'active' } } }]
  ] satisfies Array<[string, Partial<AcpAnnouncementState>]>)('announces a new %s', (_, patch) => {
    expect(transition(idle, { ...idle, ...patch })).toEqual([APPROVAL_NEEDED])
  })

  it('announces a second approval for the active chat as its own request', () => {
    const one = { ...idle, pendingPermissions: { r1: { sessionId: 'active' } } }
    const two = {
      ...idle,
      pendingPermissions: { r1: { sessionId: 'active' }, r2: { sessionId: 'active' } }
    }
    expect(transition(one, two)).toEqual([APPROVAL_NEEDED])
  })

  it('announces once when several approvals arrive together', () => {
    const next = {
      ...idle,
      pendingPermissions: { r1: { sessionId: 'active' } },
      pendingQuestions: { q1: { sessionId: 'active' } }
    }
    expect(transition(idle, next)).toEqual([APPROVAL_NEEDED])
  })

  it('does not re-announce an approval that is already pending', () => {
    const pending = { ...idle, pendingPermissions: { r1: { sessionId: 'active' } } }
    expect(transition(pending, { ...pending })).toEqual([])
  })

  it('stays silent when the approval resolves', () => {
    const pending = { ...idle, pendingPermissions: { r1: { sessionId: 'active' } } }
    expect(transition(pending, idle)).toEqual([])
  })

  it('is silent for an approval denied by a disconnect: the key just disappears', () => {
    const pending = { ...idle, pendingPermissions: { r1: { sessionId: 'active' } } }
    const denied = acpState({ sessions: twoChats({ active: { status: 'closed' } }) })
    expect(transition(pending, denied)).toEqual([])
  })

  it('announces an approval for a chat that is not active as needs-you, not as an approval', () => {
    const next = { ...idle, pendingPermissions: { r1: { sessionId: 'other' } } }
    expect(transition(idle, next)).toEqual([needsYouAnnouncement('Chat other')])
  })

  it('never announces an approval when no chat is active', () => {
    const next = { ...idle, pendingPermissions: { r1: { sessionId: 'active' } } }
    const ctx = context({ activeChatId: null })
    // With no active chat every candidate is "another chat", so the only
    // transition is that chat now needing you.
    expect(transition(idle, next, ctx)).toEqual([needsYouAnnouncement('Chat active')])
  })
})

describe('deriveAcpAnnouncements: other chat needs you', () => {
  const idle = acpState({ sessions: twoChats() })

  it('announces when a chat in the active project goes false to true', () => {
    const next = { ...idle, pendingQuestions: { q1: { sessionId: 'other' } } }
    expect(transition(idle, next)).toEqual(['Chat other needs you'])
  })

  it('announces for a closed session and for a disconnected agent', () => {
    expect(
      transition(idle, { ...idle, sessions: twoChats({ other: { status: 'closed' } }) })
    ).toEqual(['Chat other needs you'])
    expect(transition(idle, { ...idle, agentStatus: { 'agent-1': 'disconnected' } })).toEqual([
      'Chat other needs you'
    ])
  })

  it('is silent for a count change only: a second permission on a chat that already needs you', () => {
    const one = { ...idle, pendingPermissions: { r1: { sessionId: 'other' } } }
    const two = {
      ...idle,
      pendingPermissions: { r1: { sessionId: 'other' }, r2: { sessionId: 'other' } }
    }
    expect(transition(one, two)).toEqual([])
  })

  it('is silent when a needs-you chat stops being the active one', () => {
    const waiting = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'active' } }
    })
    const baseline = deriveAcpAnnouncements(null, waiting, context({ activeChatId: 'active' }))
    // The same state, now seen with another chat active: the waiting chat is
    // in another-chat territory, but it was already needing you.
    expect(
      deriveAcpAnnouncements(baseline.memory, waiting, context({ activeChatId: 'other' }))
        .announcements
    ).toEqual([])
  })

  it('is silent for a chat in another project', () => {
    const before = acpState({ sessions: { ...twoChats(), far: session({ projectId: 'p2' }) } })
    const after = {
      ...before,
      pendingPermissions: { r1: { sessionId: 'far' } }
    }
    const ctx = context({ candidateChatIds: new Set(['active', 'other', 'far']) })
    expect(transition(before, after, ctx)).toEqual([])
  })

  it('does not announce it again after switching to that project', () => {
    const before = acpState({ sessions: { ...twoChats(), far: session({ projectId: 'p2' }) } })
    const waiting = { ...before, pendingPermissions: { r1: { sessionId: 'far' } } }
    const farCandidates = new Set(['active', 'other', 'far'])
    const ctxP1 = context({ candidateChatIds: farCandidates })
    const first = deriveAcpAnnouncements(null, before, ctxP1)
    const second = deriveAcpAnnouncements(first.memory, waiting, ctxP1)
    expect(second.announcements).toEqual([])
    const ctxP2 = context({
      activeProjectId: 'p2',
      activeChatId: null,
      candidateChatIds: farCandidates
    })
    expect(deriveAcpAnnouncements(second.memory, waiting, ctxP2).announcements).toEqual([])
  })

  it('ignores chats that are not open tabs or retained', () => {
    const next = { ...idle, pendingQuestions: { q1: { sessionId: 'other' } } }
    const ctx = context({ candidateChatIds: new Set(['active']) })
    expect(transition(idle, next, ctx)).toEqual([])
  })

  it('ignores a chat that first becomes a candidate while it already needs you', () => {
    const waiting = acpState({
      sessions: twoChats(),
      pendingPermissions: { r1: { sessionId: 'other' } }
    })
    const before = context({ candidateChatIds: new Set(['active']) })
    const after = context({ candidateChatIds: new Set(['active', 'other']) })
    const baseline = deriveAcpAnnouncements(null, waiting, before)
    expect(deriveAcpAnnouncements(baseline.memory, waiting, after).announcements).toEqual([])
  })

  it('is silent for another chat holding an elicitation (denied-by-disconnect and elicitation notes)', () => {
    const next = { ...idle, pendingElicitations: { e1: { sessionId: 'other' } } }
    expect(transition(idle, next)).toEqual([])
  })

  it('uses the injected chat label lookup', () => {
    const next = { ...idle, pendingQuestions: { q1: { sessionId: 'other' } } }
    const ctx = context({ chatLabel: () => 'Agent Chat' })
    expect(transition(idle, next, ctx)).toEqual(['Agent Chat needs you'])
  })
})

describe('deriveAcpAnnouncements: turn finished', () => {
  it('announces when the active chat turn goes true to false', () => {
    const running = acpState({ sessions: twoChats({ active: { activeTurn: true } }) })
    const done = acpState({ sessions: twoChats({ active: { activeTurn: false } }) })
    expect(transition(running, done)).toEqual([TURN_FINISHED])
  })

  it('is silent for a turn that finishes in a chat that is not active', () => {
    const running = acpState({ sessions: twoChats({ other: { activeTurn: true } }) })
    const done = acpState({ sessions: twoChats({ other: { activeTurn: false } }) })
    expect(transition(running, done)).toEqual([])
  })

  it('is silent when a turn starts', () => {
    const idle = acpState({ sessions: twoChats() })
    const running = acpState({ sessions: twoChats({ active: { activeTurn: true } }) })
    expect(transition(idle, running)).toEqual([])
  })

  it('is silent when the user switches from a running chat to another chat', () => {
    const state = acpState({
      sessions: twoChats({ active: { activeTurn: true }, other: { activeTurn: false } })
    })
    const baseline = deriveAcpAnnouncements(null, state, context({ activeChatId: 'active' }))
    const switched = deriveAcpAnnouncements(
      baseline.memory,
      { ...state },
      context({ activeChatId: 'other' })
    )
    expect(switched.announcements).toEqual([])
  })

  it('announces for the new active chat when it was already running at the switch', () => {
    const running = acpState({
      sessions: twoChats({ active: { activeTurn: true }, other: { activeTurn: true } })
    })
    const baseline = deriveAcpAnnouncements(null, running, context({ activeChatId: 'active' }))
    const ended = acpState({
      sessions: twoChats({ active: { activeTurn: true }, other: { activeTurn: false } })
    })
    const result = deriveAcpAnnouncements(
      baseline.memory,
      ended,
      context({ activeChatId: 'other' })
    )
    expect(result.announcements).toEqual([TURN_FINISHED])
  })

  it('is silent when the session id changes (a different chat, not a turn end)', () => {
    const before = acpState({ sessions: { a: session({ activeTurn: true }) } })
    const after = acpState({ sessions: { b: session({ activeTurn: false }) } })
    const ctxA = context({ activeChatId: 'a', candidateChatIds: new Set(['a']) })
    const ctxB = context({ activeChatId: 'b', candidateChatIds: new Set(['b']) })
    const baseline = deriveAcpAnnouncements(null, before, ctxA)
    expect(deriveAcpAnnouncements(baseline.memory, after, ctxB).announcements).toEqual([])
  })
})

describe('deriveAcpAnnouncements: project switch', () => {
  const idle = acpState({ sessions: twoChats() })

  it('announces when a switch starts, with the project name', () => {
    expect(transition(idle, { ...idle, switchingProjectId: 'p2' })).toEqual([
      'Switching to Project p2…'
    ])
  })

  it('falls back to whatever the name lookup returns (the id when no name is found)', () => {
    const ctx = context({ projectName: (id) => id })
    expect(transition(idle, { ...idle, switchingProjectId: 'p2' }, ctx)).toEqual([
      'Switching to p2…'
    ])
  })

  it('is silent when the switch ends', () => {
    expect(transition({ ...idle, switchingProjectId: 'p2' }, idle)).toEqual([])
  })

  it('announces a failure', () => {
    expect(transition(idle, { ...idle, failedProjectSwitchId: 'p2' })).toEqual([
      "Couldn't switch to Project p2"
    ])
  })

  it('catches a failure that is cleared again in the same tick (each write is evaluated)', () => {
    const baseline = deriveAcpAnnouncements(null, idle, context())
    const failed = deriveAcpAnnouncements(
      baseline.memory,
      { ...idle, failedProjectSwitchId: 'p2' },
      context()
    )
    expect(failed.announcements).toEqual(["Couldn't switch to Project p2"])
    const cleared = deriveAcpAnnouncements(failed.memory, idle, context())
    expect(cleared.announcements).toEqual([])
  })

  it('announces a repeated failure for the same project after it was cleared', () => {
    const failed = { ...idle, failedProjectSwitchId: 'p2' }
    const a = deriveAcpAnnouncements(null, failed, context())
    const cleared = deriveAcpAnnouncements(a.memory, idle, context())
    const again = deriveAcpAnnouncements(cleared.memory, failed, context())
    expect(again.announcements).toEqual(["Couldn't switch to Project p2"])
  })

  it('does not repeat while the same switch stays in flight', () => {
    const switching = { ...idle, switchingProjectId: 'p2' }
    expect(transition(switching, { ...switching })).toEqual([])
  })

  it('announces a different target while another switch is in flight', () => {
    expect(
      transition({ ...idle, switchingProjectId: 'p2' }, { ...idle, switchingProjectId: 'p3' })
    ).toEqual(['Switching to Project p3…'])
  })
})

describe('deriveAcpAnnouncements: emission order', () => {
  it('emits switch, turn finished, needs-you, approval so that Approval needed wins', () => {
    const before = acpState({
      sessions: twoChats({ active: { activeTurn: true } })
    })
    const after = acpState({
      sessions: twoChats({ active: { activeTurn: false } }),
      switchingProjectId: 'p2',
      pendingQuestions: { q1: { sessionId: 'other' } },
      pendingPermissions: { r1: { sessionId: 'active' } }
    })
    expect(transition(before, after)).toEqual([
      'Switching to Project p2…',
      TURN_FINISHED,
      'Chat other needs you',
      APPROVAL_NEEDED
    ])
  })
})

describe('deriveConnectionAnnouncements', () => {
  const connected: ConnectionAnnouncementState = {
    controlChannel: 'connected',
    terminalChannel: 'connected'
  }

  function run(
    steps: ConnectionAnnouncementState[],
    startMemory: ConnectionAnnouncementMemory | null = null
  ): string[][] {
    let memory = startMemory
    const out: string[][] = []
    for (const step of steps) {
      const result = deriveConnectionAnnouncements(memory, step)
      memory = result.memory
      out.push(result.announcements)
    }
    return out
  }

  it('is silent on the first observation, whatever the state', () => {
    expect(
      deriveConnectionAnnouncements(null, {
        controlChannel: 'reconnecting',
        terminalChannel: 'disconnected'
      }).announcements
    ).toEqual([])
  })

  it('is silent for a fresh boot connect (connecting to connected)', () => {
    expect(
      run([
        { controlChannel: 'connecting', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], []])
  })

  it('is silent for the lazy terminal connect (connected, connecting, connected)', () => {
    expect(
      run([connected, { controlChannel: 'connected', terminalChannel: 'connecting' }, connected])
    ).toEqual([[], [], []])
  })

  it('announces control loss and recovery', () => {
    expect(
      run([
        connected,
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_RECONNECTING], [CONNECTION_CONNECTED]])
  })

  it('announces terminal loss and recovery', () => {
    expect(
      run([
        connected,
        { controlChannel: 'connected', terminalChannel: 'disconnected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_DISCONNECTED], [CONNECTION_CONNECTED]])
  })

  it('announces each loss state change, reconnecting then disconnected', () => {
    expect(
      run([
        connected,
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'disconnected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_RECONNECTING], [CONNECTION_DISCONNECTED]])
  })

  it('does not repeat while a channel stays in the same state', () => {
    expect(
      run([
        connected,
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'reconnecting', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_RECONNECTING], []])
  })

  it('keeps the lost memory across a connecting retry, then announces recovery', () => {
    expect(
      run([
        connected,
        { controlChannel: 'disconnected', terminalChannel: 'connected' },
        { controlChannel: 'connecting', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_DISCONNECTED], [], [CONNECTION_CONNECTED]])
  })

  it('tracks the lost memory per channel', () => {
    // The control channel lost and recovered must not make a quiet terminal
    // channel announce, and vice versa.
    expect(
      run([
        connected,
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'reconnecting', terminalChannel: 'connecting' },
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], [CONNECTION_RECONNECTING], [], [], [CONNECTION_CONNECTED], []])
  })

  it('does not announce recovery for a loss that was the first observation', () => {
    expect(
      run([
        { controlChannel: 'reconnecting', terminalChannel: 'connected' },
        { controlChannel: 'connected', terminalChannel: 'connected' }
      ])
    ).toEqual([[], []])
  })
})
